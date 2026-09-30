import type { AnalysisResult, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import type { DecisionSchemaV1Analysis } from "./response.js";
import type { JevErrorClass } from "./errors.js";

/**
 * AnalysisResult rows are append-only (see the schema.prisma doc comment): a
 * re-analysis after failure, or under a future schema version, always inserts a
 * new row rather than overwriting one. This is what preserves the full analysis
 * history an audit trail requires, and it's also what makes the idempotency check
 * in analyzeEmail.ts ("does a status='ok' row already exist?") a simple read
 * instead of something that has to reconcile conflicting writes.
 */
export async function persistSuccessfulAnalysis(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; emailId: string; analysis: DecisionSchemaV1Analysis; inputTruncated: boolean; latencyMs: number },
): Promise<AnalysisResult> {
  return tx.analysisResult.create({
    data: {
      tenantId: params.tenantId,
      emailId: params.emailId,
      schemaVersion: params.analysis.schemaVersion,
      jevModel: params.analysis.jevModel,
      answers: params.analysis.answers as unknown as Prisma.InputJsonValue,
      status: "ok",
      inputTokens: params.analysis.usage.inputTokens,
      outputTokens: params.analysis.usage.outputTokens,
      latencyMs: params.latencyMs,
      inputTruncated: params.inputTruncated,
    },
  });
}

export async function persistFailedAnalysis(
  tenantId: string,
  emailId: string,
  params: { schemaVersion: string; errorClass: JevErrorClass; errorMessage: string },
): Promise<AnalysisResult> {
  return prisma.analysisResult.create({
    data: {
      tenantId,
      emailId,
      schemaVersion: params.schemaVersion,
      jevModel: "unknown", // the request never got a model-confirming response back
      answers: undefined,
      status: "error",
      errorClass: params.errorClass,
      // Deliberately capped — an error message should never be a vector for
      // smuggling large amounts of (potentially attacker-influenced) content into
      // the database. JevError messages are short, static-ish descriptions (HTTP
      // status + a short body snippet at most), never full email content.
      errorMessage: params.errorMessage.slice(0, 2000),
    },
  });
}

export async function findExistingSuccessfulAnalysis(
  emailId: string,
  schemaVersion: string,
): Promise<AnalysisResult | null> {
  return prisma.analysisResult.findFirst({
    where: { emailId, schemaVersion, status: "ok" },
    orderBy: { createdAt: "desc" },
  });
}
