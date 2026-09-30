/**
 * The condition tree AST and its deterministic evaluator.
 *
 * Deliberately NOT a general-purpose expression language (this phase's explicit
 * instruction): a small, closed set of comparison operators over a fixed,
 * known-in-advance vocabulary of fields, combined with AND/OR/NOT. Nothing here
 * is dynamically interpreted as code — a condition tree is inert data.
 *
 * This module has ZERO knowledge of Jev's HTTP client, Destinations, or Actions.
 * It only knows the SHAPE of an already-persisted AnalysisResult.answers and a
 * handful of Email fields — see resolveField below. See
 * test/architecture/rulesModuleBoundary.test.ts.
 */

export type ComparisonOp = "==" | "!=" | ">=" | "<=" | ">" | "<" | "in" | "contains";

export interface ConditionLeaf {
  field: string;
  op: ComparisonOp;
  value: string | number | boolean | (string | number)[];
}

export interface ConditionGroup {
  op: "AND" | "OR";
  children: ConditionNode[];
}

export interface ConditionNot {
  op: "NOT";
  child: ConditionNode;
}

export type ConditionNode = ConditionLeaf | ConditionGroup | ConditionNot;

/**
 * Case-insensitive text for "contains", safe for Turkish. Plain toLowerCase()
 * turns "İ" into "i" + a combining dot (so "İLK" never contained "ilk") and "I"
 * into "i" (so "ŞİFRE SIFIRLAMA" never contained "sıfırlama"). Folding: lower
 * case, drop the combining dot, and treat dotless ı as i — on both sides.
 */
export function foldForMatch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\u0307/g, "").normalize("NFC").replace(/ı/g, "i");
}

export function isConditionLeaf(node: ConditionNode): node is ConditionLeaf {
  return "field" in node;
}

/**
 * The deterministic email/analysis context a condition tree is evaluated
 * against. Intentionally narrow — only what conditions can actually reference.
 */
export interface EvaluationContext {
  email: {
    fromAddress: string;
    toAddresses: string[];
    subject: string | null;
    hasAttachments: boolean;
    attachmentFilenames: string[];
  };
  /** The raw, already-validated Jev answers map (AnalysisResult.answers) — this module never talks to Jev itself. */
  answers: Record<string, unknown>;
  /** Phase 22: fields derived as of arrival (derivedFields.ts); absent = unknown. */
  derived?: { businessHours?: boolean; isReply?: boolean; firstFromSender?: boolean; senderLast24h?: number; spf?: string; dkim?: string; dmarc?: string; authenticated?: boolean };
}

export type FieldValue = string | number | boolean | string[] | undefined;

/**
 * Resolves a condition leaf's `field` path to a concrete value from the context.
 *
 * Supported deterministic fields (SPF/DKIM/DMARC arrive in Phase 27 as derived
 * fields — see derivedFields.ts):
 *   sender.address, sender.domain, recipient.address, subject,
 *   has_attachment, attachment.filename
 *
 * Supported Jev-signal fields, resolved against AnalysisResult.answers:
 *   answers.<questionId>            -> noul: 0..1 number
 *                                       choice: the chosen option, as a string
 *                                       score: the weighted mean over level indices, 0..(N-1)
 *   answers.<questionId>.confidence -> number, 0..1 (choice/score only — noul
 *                                       answers have no confidence field, per
 *                                       docs.typesafe.ai/confidence.md)
 *
 * Returns undefined for an unresolvable field (missing answer, wrong field name)
 * — callers treat undefined as "this leaf cannot be evaluated," never as a value
 * to compare, per this phase's "missing signal -> fail safe, not fail open."
 */
export function resolveField(field: string, ctx: EvaluationContext): FieldValue {
  switch (field) {
    case "sender.address":
      return ctx.email.fromAddress;
    case "sender.domain":
      return ctx.email.fromAddress.split("@")[1]?.toLowerCase();
    case "recipient.address":
      return ctx.email.toAddresses;
    case "subject":
      return ctx.email.subject ?? "";
    case "has_attachment":
      return ctx.email.hasAttachments;
    case "attachment.filename":
      return ctx.email.attachmentFilenames;
    case "email.business_hours":
      return ctx.derived?.businessHours;
    case "email.is_reply":
      return ctx.derived?.isReply;
    case "sender.first_email":
      return ctx.derived?.firstFromSender;
    case "sender.emails_last_24h":
      return ctx.derived?.senderLast24h;
    case "sender.spf":
      return ctx.derived?.spf;
    case "sender.dkim":
      return ctx.derived?.dkim;
    case "sender.dmarc":
      return ctx.derived?.dmarc;
    case "sender.authenticated":
      return ctx.derived?.authenticated;
  }

  if (field.startsWith("answers.")) {
    const rest = field.slice("answers.".length);
    const [questionId, sub] = rest.split(".") as [string, string | undefined];
    const answer = ctx.answers[questionId];
    if (answer === undefined || answer === null || typeof answer !== "object") return undefined;
    const record = answer as Record<string, unknown>;

    if (sub === "confidence") {
      return typeof record.confidence === "number" ? record.confidence : undefined;
    }
    if (sub !== undefined) return undefined; // unknown sub-field

    if (typeof record.noul === "number") return record.noul;
    if (typeof record.choice === "string") return record.choice;
    if (typeof record.score === "number") return record.score;
    return undefined;
  }

  return undefined;
}

export interface EvaluationTrace {
  matched: boolean;
  /** One entry per leaf actually evaluated, in evaluation order — the "why did it match" record persisted on RuleEvaluation.reason. */
  leaves: Array<{ field: string; op: ComparisonOp; expected: unknown; actual: FieldValue; result: boolean }>;
  /** Set when a leaf could not be evaluated at all (unresolvable field, type mismatch) — the whole tree is then treated as non-matching, never as matching. */
  error?: string;
}

export function evaluateCondition(node: ConditionNode, ctx: EvaluationContext): EvaluationTrace {
  const leaves: EvaluationTrace["leaves"] = [];
  try {
    const matched = evaluateNode(node, ctx, leaves);
    return { matched, leaves };
  } catch (error) {
    return { matched: false, leaves, error: error instanceof Error ? error.message : String(error) };
  }
}

function evaluateNode(node: ConditionNode, ctx: EvaluationContext, leaves: EvaluationTrace["leaves"]): boolean {
  if (isConditionLeaf(node)) {
    return evaluateLeaf(node, ctx, leaves);
  }
  if (node.op === "NOT") {
    return !evaluateNode(node.child, ctx, leaves);
  }
  if (node.op === "AND") {
    // Evaluate every child (not short-circuit) so the trace always shows the
    // full picture of why a rule did or didn't match, not just the first failure.
    const results = node.children.map((child) => evaluateNode(child, ctx, leaves));
    return results.every(Boolean);
  }
  // OR
  const results = node.children.map((child) => evaluateNode(child, ctx, leaves));
  return results.some(Boolean);
}

function evaluateLeaf(leaf: ConditionLeaf, ctx: EvaluationContext, leaves: EvaluationTrace["leaves"]): boolean {
  const actual = resolveField(leaf.field, ctx);
  const result = compare(actual, leaf.op, leaf.value, leaf.field);
  leaves.push({ field: leaf.field, op: leaf.op, expected: leaf.value, actual, result });
  return result;
}

/**
 * The threshold `field == true` / `field == false` means when `field` resolves to
 * a probability (a Noul answer, always 0..1). Documented explicitly here, not
 * hidden: `== true` means "probability >= 0.5", `== false` means "< 0.5". A rule
 * author who wants a different threshold writes the numeric form directly
 * (`is_spam >= 0.9`) instead — this boolean form is convenience sugar for the
 * common case, never a silent reinterpretation of what the number means.
 */
const NOUL_BOOLEAN_THRESHOLD = 0.5;

function compare(actual: FieldValue, op: ComparisonOp, expected: ConditionLeaf["value"], field: string): boolean {
  // A missing/unresolvable value never satisfies any comparison — fail safe.
  if (actual === undefined) return false;

  if (typeof actual === "number" && typeof expected === "boolean" && (op === "==" || op === "!=")) {
    const isTrue = actual >= NOUL_BOOLEAN_THRESHOLD;
    return op === "==" ? isTrue === expected : isTrue !== expected;
  }

  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">=":
    case "<=":
    case ">":
    case "<": {
      if (typeof actual !== "number" || typeof expected !== "number") {
        throw new Error(`Operator "${op}" on field "${field}" requires numeric values, got ${typeof actual}/${typeof expected}`);
      }
      if (op === ">=") return actual >= expected;
      if (op === "<=") return actual <= expected;
      if (op === ">") return actual > expected;
      return actual < expected;
    }
    case "in": {
      if (!Array.isArray(expected)) {
        throw new Error(`Operator "in" on field "${field}" requires an array value`);
      }
      return (expected as (string | number)[]).includes(actual as string | number);
    }
    case "contains": {
      if (Array.isArray(actual)) {
        return actual.some((v) => typeof v === "string" && typeof expected === "string" && foldForMatch(v).includes(foldForMatch(expected)));
      }
      if (typeof actual === "string" && typeof expected === "string") {
        return foldForMatch(actual).includes(foldForMatch(expected));
      }
      throw new Error(`Operator "contains" on field "${field}" requires a string (or string[]) value`);
    }
  }
}
