import type { AnalysisResult } from "@prisma/client";

export interface AnalysisResultResponse {
  id: string;
  emailId: string;
  schemaVersion: string;
  jevModel: string;
  status: string;
  answers: unknown | null;
  errorClass: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  inputTruncated: boolean;
  createdAt: string;
}

/** `answers` is Jev's own structured, schema-validated decision output (is_spam, category, ...) — already product data, not a prompt/system instruction, and never raw email content. No prompt/system-instruction text is stored on this model at all (see modules/jev/persistAnalysis.ts), so there's nothing further to redact here. */
export function serializeAnalysisResult(row: AnalysisResult): AnalysisResultResponse {
  return {
    id: row.id,
    emailId: row.emailId,
    schemaVersion: row.schemaVersion,
    jevModel: row.jevModel,
    status: row.status,
    answers: row.answers,
    errorClass: row.errorClass,
    errorMessage: row.errorMessage,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    inputTruncated: row.inputTruncated,
    createdAt: row.createdAt.toISOString(),
  };
}
