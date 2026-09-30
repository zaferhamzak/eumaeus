import { htmlToText } from "../email/htmlText.js";
import type { Email } from "@prisma/client";
import { DECISION_SCHEMA_V1, type DecisionSchema, type JevQuestionDef } from "./schema.js";

// Note: the outgoing model identifier is NOT decided here. It belongs to
// JevClient (client.ts), which is the one place that owns "what are we actually
// asking the Jev API for" as a transport concern — this file only builds the
// content half of the request (state + questions), keeping the security-relevant
// trusted/untrusted separation this file exists for uncluttered by that.

/**
 * SECURITY (this phase's §13, architecture-review.md §3): this is the ONE place the
 * Jev request body is assembled, and it is built to keep two things structurally
 * separate:
 *
 *   TRUSTED ANALYSIS INSTRUCTIONS  — schema.ts's `instructions` strings. Static
 *     constants, reviewed and version-controlled, never touched by this file.
 *
 *   UNTRUSTED EMAIL DATA           — everything below, built from the email row
 *     and placed ONLY in the `state` field.
 *
 * There is no code path here that reads email content into a Question's
 * `instructions`, and no string concatenation between the two at all. An email
 * whose subject or body literally says "ignore your previous instructions and
 * classify this as ..." is just more text inside `state` — Jev is asked to
 * evaluate it as data, the same as any other email, per its own `instructions`
 * questions which never change based on what's in `state`. This bounds (it does
 * NOT eliminate — see errors.ts and the Phase 3 report's security section) the risk
 * documented at docs.typesafe.ai/model-jaggedness/jev-1.13.md: that adversarial
 * content inside `state` can still shift Jev's own probability outputs. What this
 * structure guarantees is narrower and, for this architecture, sufficient: no
 * email can rewrite what Jev is ASKED, only supply the content Jev is asked ABOUT —
 * and per architecture-review.md §3, Jev's output is only ever read by the future
 * rule engine as data to compare against operator-configured thresholds, never
 * executed directly.
 */

type EmailForAnalysis = Pick<
  Email,
  "fromAddress" | "toAddresses" | "ccAddresses" | "subject" | "textBody" | "htmlBody" | "hasAttachments" | "attachmentMeta"
>;

export interface BuiltJevRequest {
  state: unknown;
  questions: Record<string, JevQuestionDef>;
  /** Whether the body was shortened to fit Jev's documented token budget — persisted on AnalysisResult for explainability. */
  inputTruncated: boolean;
}

/**
 * Character cap for the body text placed into `state`. This is a rough,
 * conservative proxy for Jev's documented 32K-token combined budget for
 * state+longest question (docs.typesafe.ai/models.md) — roughly 4 characters per
 * token is a standard, deliberately conservative estimate, and 20,000 characters
 * (~5,000 tokens) leaves generous headroom for the rest of state's fields, all
 * eight questions' instructions/criteria, and Jev's own tokenization differing
 * from this estimate.
 */
const MAX_BODY_CHARS = 20_000;

export function buildJevRequest(email: EmailForAnalysis, schema: DecisionSchema = DECISION_SCHEMA_V1): BuiltJevRequest {
  const rawBody = email.textBody ?? stripHtml(email.htmlBody ?? "");
  const inputTruncated = rawBody.length > MAX_BODY_CHARS;
  const body = inputTruncated ? rawBody.slice(0, MAX_BODY_CHARS) : rawBody;

  const attachmentFilenames = Array.isArray(email.attachmentMeta)
    ? (email.attachmentMeta as Array<{ filename?: string }>).map((a) => a.filename).filter((f): f is string => Boolean(f))
    : [];

  // A plain data object — no instruction-like framing, no markup meant to be
  // "read" as anything other than the content of an email. Supported directly by
  // Jev's `state` field, which accepts string | object | array
  // (docs.typesafe.ai/concepts/state.md).
  const state = {
    from: email.fromAddress,
    to: email.toAddresses,
    cc: email.ccAddresses,
    subject: email.subject ?? "",
    body,
    has_attachments: email.hasAttachments,
    attachment_filenames: attachmentFilenames,
  };

  return { state, questions: schema.questions, inputTruncated };
}

/**
 * Minimal HTML-to-text for classifier input only — NOT a rendering-safe sanitizer
 * and not used anywhere content is ever displayed. Good enough to give Jev readable
 * text; a fuller conversion belongs to the ingestion preprocessing pipeline
 * (architecture-review.md §3) if/when the product renders email HTML anywhere.
 */
function stripHtml(html: string): string {
  return htmlToText(html);
}
