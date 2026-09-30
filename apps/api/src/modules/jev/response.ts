import { z } from "zod";
import type { DecisionSchema, JevQuestionDef } from "./schema.js";
import { JevMalformedResponseError } from "./errors.js";

/**
 * Per-primitive answer shapes.
 *
 *   - Noul:   { noul: number }                                          (0..1)
 *   - Choice: { choice: string, probabilities: {optionName: number}, confidence: number }
 *   - Score:  { score: number, legend: {"0": string|LegendDetail, ...},
 *               probabilities: {"0": number, "1": number, ...}, confidence: number }
 *
 * Score was corrected here after a REAL API call surfaced a mismatch with this
 * project's earlier assumption (score as a string label, mirroring Choice) —
 * caught by response validation itself doing its job, not silently accepted.
 * Verified against docs.typesafe.ai/primitives/score.md (checked 2026-09-23,
 * during Phase 3 real-API verification — this specific sub-page was missed in
 * the original Phase 3 research pass, which only fetched the /primitives.md
 * overview): `score` is a continuous weighted mean — "each level number
 * multiplied by its probability, added up" (e.g. 0×0.93 + 1×0.07 = 0.07) — NOT a
 * discrete label. `legend` and `probabilities` are both keyed by the level's
 * INDEX AS A STRING ("0", "1", ...), where index 0 corresponds to the first
 * entry in the `criteria` array we sent, mapped via `legend`. This is genuinely
 * different from Choice, where `probabilities` is keyed by the option NAME
 * directly — the two primitives are not shaped alike despite both being
 * "pick from an ordered/labeled set" on the surface.
 *
 * Deliberately NOT flattened into an invented shape (e.g. a single fabricated
 * "overall confidence" for the whole analysis) — Jev has no such field, and
 * inventing one would violate this phase's explicit instruction to preserve the
 * API's actual confidence semantics rather than substitute our own interpretation.
 */
const noulAnswerSchema = z.object({ noul: z.number().min(0).max(1) });
const choiceAnswerSchema = z.object({
  choice: z.string(),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});
const legendEntrySchema = z.union([z.string(), z.object({ what: z.string(), examples: z.array(z.string()).optional() })]);
const scoreAnswerSchema = z.object({
  score: z.number(),
  legend: z.record(legendEntrySchema),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});

export type NoulAnswer = z.infer<typeof noulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

const responseEnvelopeSchema = z.object({
  model: z.string(),
  answers: z.record(z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export interface DecisionSchemaV1Analysis {
  schemaVersion: string;
  /** The model string ECHOED BACK by Jev, not merely what we requested — see AnalysisResult.jevModel's doc comment. */
  jevModel: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  /** Phase 22: optional (custom) questions whose answer was missing or malformed and was left out. */
  skipped: string[];
}

/**
 * Validates a raw Jev HTTP response body against `schema` and normalizes it into
 * the internal Decision Schema v1 representation.
 *
 *   Jev response -> validation -> normalization -> internal DecisionSchemaV1
 *
 * "Normalization" here means: every answer is checked against its DECLARED
 * primitive type (noul/choice/score) and, for choice/score, that the returned
 * value is one of the options we actually configured — turning `unknown` into a
 * strongly-typed, schema-conformant record. It does NOT reinterpret the values
 * themselves (no threshold-to-boolean collapsing, no confidence rescaling) — see
 * this file's other doc comments for why.
 *
 * Throws JevMalformedResponseError (non-retryable) on any mismatch: missing
 * top-level fields, a missing answer for a configured question, an answer that
 * doesn't match its primitive's shape, or a choice/score value outside the
 * criteria we sent. All of these represent Jev returning something our own
 * request didn't ask for, which a same-input retry is very unlikely to fix.
 */
export function validateJevResponse(schema: DecisionSchema, raw: unknown, optionalKeys: ReadonlySet<string> = new Set()): DecisionSchemaV1Analysis {
  const envelope = responseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new JevMalformedResponseError(`Jev response envelope did not match the expected shape: ${envelope.error.message}`);
  }

  const answers: Record<string, JevAnswer> = {};
  const skipped: string[] = [];
  for (const [questionId, questionDef] of Object.entries(schema.questions)) {
    const rawAnswer = envelope.data.answers[questionId];
    // Phase 22: an organization's own question never sinks the whole analysis
    // — the built-in eight still route the email; that one answer is absent
    // (rules reading it then simply don't match).
    if (optionalKeys.has(questionId)) {
      try {
        if (rawAnswer === undefined) throw new JevMalformedResponseError("missing");
        answers[questionId] = validateOneAnswer(questionId, questionDef, rawAnswer);
      } catch {
        skipped.push(questionId);
      }
      continue;
    }
    if (rawAnswer === undefined) {
      throw new JevMalformedResponseError(`Jev response is missing an answer for question "${questionId}"`);
    }
    answers[questionId] = validateOneAnswer(questionId, questionDef, rawAnswer);
  }

  return {
    schemaVersion: schema.version,
    jevModel: envelope.data.model,
    answers,
    usage: { inputTokens: envelope.data.usage.input_tokens, outputTokens: envelope.data.usage.output_tokens },
    skipped,
  };
}

function validateOneAnswer(questionId: string, def: JevQuestionDef, rawAnswer: unknown): JevAnswer {
  if (def.type === "noul") {
    const parsed = noulAnswerSchema.safeParse(rawAnswer);
    if (!parsed.success) {
      throw new JevMalformedResponseError(
        `Answer for noul question "${questionId}" did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  if (def.type === "choice") {
    const parsed = choiceAnswerSchema.safeParse(rawAnswer);
    if (!parsed.success) {
      throw new JevMalformedResponseError(
        `Answer for choice question "${questionId}" did not match the expected shape: ${parsed.error.message}`,
      );
    }
    if (!(parsed.data.choice in def.criteria)) {
      throw new JevMalformedResponseError(
        `Answer for choice question "${questionId}" returned "${parsed.data.choice}", which is outside the configured criteria`,
      );
    }
    return parsed.data;
  }

  // def.type === "score"
  const parsed = scoreAnswerSchema.safeParse(rawAnswer);
  if (!parsed.success) {
    throw new JevMalformedResponseError(
      `Answer for score question "${questionId}" did not match the expected shape: ${parsed.error.message}`,
    );
  }
  // `score` is a continuous weighted mean over the level indices [0, N-1] (see
  // this file's top doc comment) — a valid answer must fall within that range,
  // not equal any single one of them.
  const maxIndex = def.criteria.length - 1;
  if (parsed.data.score < 0 || parsed.data.score > maxIndex) {
    throw new JevMalformedResponseError(
      `Answer for score question "${questionId}" returned ${parsed.data.score}, outside the valid range [0, ${maxIndex}] for ${def.criteria.length} configured levels`,
    );
  }
  // `probabilities`/`legend` should cover exactly the level indices we configured.
  const expectedIndices = def.criteria.map((_, i) => String(i));
  const probabilityIndices = Object.keys(parsed.data.probabilities);
  const missingIndices = expectedIndices.filter((i) => !probabilityIndices.includes(i));
  if (missingIndices.length > 0) {
    throw new JevMalformedResponseError(
      `Answer for score question "${questionId}" is missing probabilities for level index(es) ${missingIndices.join(", ")}`,
    );
  }
  return parsed.data;
}
