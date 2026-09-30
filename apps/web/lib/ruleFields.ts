import { apiRequest } from "@/lib/api/client";
import type { ComparisonOp } from "@/types/api";

/**
 * The editor's field vocabulary. Since Phase 22 the authoritative list comes
 * from the backend (GET /api/v1/rules/fields — built-in fields, derived
 * arrival-context fields and the organization's own custom Jev questions);
 * the static list below mirrors apps/api/src/modules/rules/knownFields.ts and
 * is only the fallback/initial data while that request is loading or failed.
 * §17: "do NOT invent new operators... do NOT silently translate unsupported
 * conditions." The backend's own validateRule() remains the real authority (a
 * mismatch here surfaces as a normal VALIDATION_ERROR, never a silent
 * acceptance).
 */
export type FieldType = "string" | "number" | "boolean" | "string[]";
export type FieldSource = "email" | "jev" | "derived" | "custom";

export interface RuleFieldInfo {
  field: string;
  type: FieldType;
  source: FieldSource;
}

export const STATIC_RULE_FIELDS: readonly RuleFieldInfo[] = [
  { field: "sender.address", type: "string", source: "email" },
  { field: "sender.domain", type: "string", source: "email" },
  { field: "recipient.address", type: "string[]", source: "email" },
  { field: "subject", type: "string", source: "email" },
  { field: "has_attachment", type: "boolean", source: "email" },
  { field: "attachment.filename", type: "string[]", source: "email" },
  { field: "answers.is_spam", type: "number", source: "jev" },
  { field: "answers.is_business_opportunity", type: "number", source: "jev" },
  { field: "answers.is_collaboration", type: "number", source: "jev" },
  { field: "answers.is_customer_related", type: "number", source: "jev" },
  { field: "answers.requires_response", type: "number", source: "jev" },
  { field: "answers.human_review_required", type: "number", source: "jev" },
  { field: "answers.category", type: "string", source: "jev" },
  { field: "answers.category.confidence", type: "number", source: "jev" },
  { field: "answers.urgency", type: "number", source: "jev" },
  { field: "answers.urgency.confidence", type: "number", source: "jev" },
  // Phase 22: derived arrival-context fields (computed as of the email's arrival).
  { field: "email.business_hours", type: "boolean", source: "derived" },
  { field: "email.is_reply", type: "boolean", source: "derived" },
  { field: "sender.first_email", type: "boolean", source: "derived" },
  { field: "sender.emails_last_24h", type: "number", source: "derived" },
  // Phase 27: the receiving provider's verdict on the sender.
  { field: "sender.spf", type: "string", source: "derived" },
  { field: "sender.dkim", type: "string", source: "derived" },
  { field: "sender.dmarc", type: "string", source: "derived" },
  { field: "sender.authenticated", type: "boolean", source: "derived" },
];

export const KNOWN_FIELDS: Record<string, FieldType> = Object.fromEntries(
  STATIC_RULE_FIELDS.map((f) => [f.field, f.type]),
);

export const KNOWN_FIELD_NAMES = STATIC_RULE_FIELDS.map((f) => f.field);

/** GET /api/v1/rules/fields — the organization's full field catalog. */
export function listRuleFields(signal?: AbortSignal) {
  return apiRequest<{ data: RuleFieldInfo[] }>("/api/v1/rules/fields", {
    signal,
  });
}

/** A field's type from the given catalog (falling back to the static list); undefined for an unknown field. */
export function fieldTypeOf(
  field: string,
  fields: readonly RuleFieldInfo[] = STATIC_RULE_FIELDS,
): FieldType | undefined {
  const found = fields.find((f) => f.field === field);
  if (found) return found.type;
  return Object.prototype.hasOwnProperty.call(KNOWN_FIELDS, field)
    ? KNOWN_FIELDS[field]
    : undefined;
}

const ALL_OPS: ComparisonOp[] = [
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<",
  "in",
  "contains",
];
const NUMERIC_OPS: ComparisonOp[] = [">=", "<=", ">", "<"];

/**
 * The operators valid for a given field's type — mirrors validateRule.ts's own
 * rules (numeric comparisons only on number fields, "contains" only on
 * string/string[], "in" takes a list). Boolean fields only offer == and !=.
 * An unknown field keeps every operator (the backend decides).
 */
export function operatorsForField(
  field: string,
  fields?: readonly RuleFieldInfo[],
): ComparisonOp[] {
  const type = fieldTypeOf(field, fields);
  if (!type) return ALL_OPS;
  if (type === "boolean") return ["==", "!="];
  return ALL_OPS.filter((op) => {
    if (NUMERIC_OPS.includes(op)) return type === "number";
    if (op === "contains") return type === "string" || type === "string[]";
    return true; // ==, !=, in
  });
}
