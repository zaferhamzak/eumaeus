/**
 * The closed vocabulary of fields a condition leaf may reference, and each
 * field's value type (for operator validation in validateRule.ts).
 *
 * DELIBERATELY duplicated here rather than imported from modules/jev/schema.ts:
 * this phase's explicit instruction is that the Rule Engine stays separate from
 * modules/jev/ with zero dependency on it, not just that it doesn't call the Jev
 * HTTP API. A mismatch between this list and the real Decision Schema v1 question
 * ids is a configuration bug (a rule referencing a field that doesn't actually
 * exist in AnalysisResult.answers evaluates safely to "field unresolvable ->
 * leaf doesn't match" per conditions.ts, never to an error that blocks other
 * rules) — see test/architecture/rulesModuleBoundary.test.ts for the enforced
 * import boundary.
 */
export type FieldType = "string" | "number" | "boolean" | "string[]";

export const KNOWN_FIELDS: Record<string, FieldType> = {
  "sender.address": "string",
  "sender.domain": "string",
  "recipient.address": "string[]",
  subject: "string",
  has_attachment: "boolean",
  "attachment.filename": "string[]",

  "answers.is_spam": "number",
  "answers.is_business_opportunity": "number",
  "answers.is_collaboration": "number",
  "answers.is_customer_related": "number",
  "answers.requires_response": "number",
  "answers.human_review_required": "number",
  "answers.category": "string",
  "answers.category.confidence": "number",
  "answers.urgency": "number",
  "answers.urgency.confidence": "number",

  // Phase 22: derived as of the email's arrival (see derivedFields.ts).
  "email.business_hours": "boolean",
  "email.is_reply": "boolean",
  "sender.first_email": "boolean",
  "sender.emails_last_24h": "number",

  // Phase 27: the receiving provider's verdict on the sender (see senderAuth.ts).
  "sender.spf": "string",
  "sender.dkim": "string",
  "sender.dmarc": "string",
  "sender.authenticated": "boolean",
};

export function isKnownField(field: string): boolean {
  return field in KNOWN_FIELDS;
}
