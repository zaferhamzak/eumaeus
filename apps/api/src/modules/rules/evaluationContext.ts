import type { EvaluationContext } from "./conditions.js";
import type { DerivedFields } from "./derivedFields.js";

/** The fields of an Email a condition can see. Shared by the live engine and the simulator so both read an email identically. */
export interface EmailForEvaluation {
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  hasAttachments: boolean;
  attachmentMeta: unknown;
  /** Phase 22: computed by derivedFields.ts before deciding; absent = unknown. */
  derived?: DerivedFields;
}

export function buildEvaluationContext(email: EmailForEvaluation, answers: Record<string, unknown>): EvaluationContext {
  const attachmentFilenames = Array.isArray(email.attachmentMeta)
    ? (email.attachmentMeta as Array<{ filename?: string }>).map((a) => a.filename).filter((f): f is string => Boolean(f))
    : [];
  return {
    email: {
      fromAddress: email.fromAddress,
      toAddresses: email.toAddresses,
      subject: email.subject,
      hasAttachments: email.hasAttachments,
      attachmentFilenames,
    },
    answers,
    ...(email.derived ? { derived: email.derived } : {}),
  };
}

export function extractNoul(answer: unknown): number | undefined {
  if (answer && typeof answer === "object" && typeof (answer as { noul?: unknown }).noul === "number") {
    return (answer as { noul: number }).noul;
  }
  return undefined;
}
