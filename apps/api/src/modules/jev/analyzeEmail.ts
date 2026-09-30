import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { EmailState } from "../../types/email-state.js";
import { loadEnv } from "../../config/env.js";
import { JevClient } from "./client.js";
import { buildJevRequest } from "./request.js";
import { validateJevResponse } from "./response.js";
import { DECISION_SCHEMA_V1, type DecisionSchema } from "./schema.js";
import { customQuestionDefs } from "../questions/tenantQuestions.js";
import { persistSuccessfulAnalysis, persistFailedAnalysis, findExistingSuccessfulAnalysis } from "./persistAnalysis.js";
import { JevError } from "./errors.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";

export type JevClientFactory = () => JevClient;

function defaultClientFactory(): JevClient {
  const env = loadEnv();
  return new JevClient({
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL_VERSION,
    baseUrl: env.JEV_API_BASE_URL,
    timeoutMs: env.JEV_TIMEOUT_MS,
  });
}

/**
 * The pipeline this phase implements:
 *
 *   Email -> process-email job -> load normalized email -> build Jev request
 *   -> Jev -> validate response -> Decision Schema v1 -> persist analysis
 *   -> audit -> state = analyzed
 *
 * This function is the ONLY thing queue/workers/processEmail.worker.ts calls —
 * that worker file contains zero Jev-specific logic, exactly mirroring how
 * queue/workers/mailboxSync.worker.ts is a thin wrapper around syncMailbox().
 *
 * Idempotency (this phase's §10 — "the database must provide the final
 * consistency boundary," not BullMQ job IDs alone): before doing anything, checks
 * whether a successful AnalysisResult already exists for this email under the
 * current schema version. If so, this call is a no-op except for a state fix-up —
 * this is exactly what makes "Jev succeeded, then the process crashed before the
 * job was acknowledged, then BullMQ redelivered the job" safe: the retry sees the
 * prior success and does not call Jev (or write a second canonical analysis) again.
 *
 * Dependency boundary (this phase's §14, verified by
 * test/architecture/jevModuleBoundary.test.ts): this file and everything it
 * imports touches only Email/AnalysisResult/AuditEvent and the Jev HTTP client.
 * Nothing here knows what a Destination, Action, webhook, forward, archive, or
 * reply is — Jev's output is persisted as data; deciding what to DO about it is
 * explicitly a future phase's job.
 *
 * Throws the underlying JevError (see errors.ts) when the analysis attempt fails.
 * The caller — the process-email worker — is responsible for deciding what a
 * thrown error means operationally (retry vs. immediate escalation), based on
 * `error.retryable`; this function's only job is to try once (with the client's
 * own internal retry budget already applied) and record what happened.
 */
export async function analyzeEmail(emailId: string, clientFactory: JevClientFactory = defaultClientFactory, options: { force?: boolean } = {}): Promise<void> {
  const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });

  // Phase 22: `force` asks Jev again even when an analysis exists (reprocess
  // with "ask Jev again", e.g. after adding a question). The newest successful
  // analysis is the one routing reads.
  const existing = options.force ? null : await findExistingSuccessfulAnalysis(emailId, DECISION_SCHEMA_V1.version);
  if (existing) {
    if (email.state !== EmailState.ANALYZED) {
      await prisma.email.update({
        where: { id: emailId },
        data: { state: EmailState.ANALYZED, stateUpdatedAt: new Date() },
      });
    }
    return;
  }

  if (email.state !== EmailState.ANALYZING) {
    await prisma.email.update({
      where: { id: emailId },
      data: { state: EmailState.ANALYZING, stateUpdatedAt: new Date() },
    });
  }

  await recordAuditEvent(prisma, {
    tenantId: email.tenantId,
    emailId: email.id,
    eventType: AuditEventType.ANALYSIS_STARTED,
    actor: "system",
    payload: { schemaVersion: DECISION_SCHEMA_V1.version },
  });

  // Phase 22: the organization's own questions are asked alongside the
  // built-in eight, in the same request (Jev evaluates questions in parallel).
  const custom = await customQuestionDefs(email.tenantId);
  const schema: DecisionSchema = { version: DECISION_SCHEMA_V1.version, questions: { ...DECISION_SCHEMA_V1.questions, ...custom } };
  const { state, questions, inputTruncated } = buildJevRequest(email, schema);
  const client = clientFactory();

  try {
    const { raw, latencyMs } = await client.analyze(state, questions);
    const analysis = validateJevResponse(schema, raw, new Set(Object.keys(custom)));

    await prisma.$transaction(async (tx) => {
      await persistSuccessfulAnalysis(tx, {
        tenantId: email.tenantId,
        emailId: email.id,
        analysis,
        inputTruncated,
        latencyMs,
      });
      await tx.email.update({
        where: { id: email.id },
        data: { state: EmailState.ANALYZED, stateUpdatedAt: new Date() },
      });
      await recordAuditEvent(tx, {
        tenantId: email.tenantId,
        emailId: email.id,
        eventType: AuditEventType.ANALYSIS_SUCCEEDED,
        actor: "system",
        payload: {
          schemaVersion: analysis.schemaVersion,
          jevModel: analysis.jevModel,
          latencyMs,
          inputTruncated,
          // Question ids answered, not the answers themselves — keeps the audit
          // trail informative without duplicating AnalysisResult.answers here.
          questionsAnswered: Object.keys(analysis.answers),
          ...(analysis.skipped.length > 0 ? { customQuestionsSkipped: analysis.skipped } : {}),
        },
      });
    });
    metrics.increment(MetricName.ANALYSIS_RESULT, { status: "ok" });
  } catch (error) {
    const jevError = error instanceof JevError ? error : undefined;
    await persistFailedAnalysis(email.tenantId, email.id, {
      schemaVersion: DECISION_SCHEMA_V1.version,
      errorClass: jevError?.errorClass ?? "connection",
      errorMessage: jevError?.message ?? String(error),
    });
    await recordAuditEvent(prisma, {
      tenantId: email.tenantId,
      emailId: email.id,
      eventType: AuditEventType.ANALYSIS_FAILED,
      actor: "system",
      payload: { errorClass: jevError?.errorClass ?? "unknown", retryable: jevError?.retryable ?? false },
    });
    metrics.increment(MetricName.ANALYSIS_RESULT, { status: "error" });
    throw error;
  }
}
