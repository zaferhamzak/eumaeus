import { Prisma, type TenantQuestion } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { DECISION_SCHEMA_V1, type JevQuestionDef } from "../jev/schema.js";

/**
 * Phase 22: an organization's own questions for Jev. Jev takes the question
 * set with every request (docs.typesafe.ai/api.md: "a map of typed Question
 * objects. You choose each key."), so a custom question is simply added to the
 * built-in eight for that organization's emails, and its answer is stored with
 * the others in AnalysisResult.answers — a rule reads it as answers.<key>.
 *
 * Same trust boundary as the built-in questions: `instructions` and `criteria`
 * are written by the organization's admins, never built from email content;
 * the email only ever travels in Jev's `state`.
 *
 *   key       lowercase letters, digits, underscores; not a built-in name;
 *             unique in the organization (also among deleted ones, so an old
 *             analysis never means two different things); never changes
 *   type      noul (yes/no probability), choice (one of up to 50 options),
 *             score (2–10 ordered levels); never changes
 *   limit     MAX_QUESTIONS active questions per organization
 */
export const MAX_QUESTIONS = 20;
export const MAX_INSTRUCTIONS = 1000;
export const MAX_CHOICE_OPTIONS = 50;
export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const BUILT_IN_KEYS = new Set(Object.keys(DECISION_SCHEMA_V1.questions));
const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export class QuestionError extends Error {
  constructor(
    message: string,
    public readonly kind: "invalid" | "not_found" | "in_use" = "invalid",
    public readonly usedBy: string[] = [],
  ) {
    super(message);
  }
}

export interface QuestionInput {
  key: string;
  type: QuestionType;
  instructions: string;
  criteria?: unknown;
}

function cleanText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;
}

/** Validates type-specific criteria and returns the normalized form stored and sent to Jev. */
export function normalizeCriteria(type: QuestionType, criteria: unknown): Prisma.InputJsonValue | null {
  if (type === "choice") {
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw new QuestionError("A choice question needs its options: { option: description }");
    const entries = Object.entries(criteria as Record<string, unknown>);
    if (entries.length < 2 || entries.length > MAX_CHOICE_OPTIONS) throw new QuestionError(`A choice question needs 2–${MAX_CHOICE_OPTIONS} options`);
    const out: Record<string, string> = {};
    for (const [option, description] of entries) {
      if (!KEY_PATTERN.test(option)) throw new QuestionError(`Option "${option}": use lowercase letters, digits and underscores (it's the value rules compare against)`);
      const text = cleanText(description, 300);
      if (!text) throw new QuestionError(`Option "${option}" needs a description (up to 300 characters)`);
      out[option] = text;
    }
    return out;
  }
  if (type === "score") {
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) throw new QuestionError("A score question needs 2–10 ordered levels, lowest first");
    const levels = criteria.map((l) => cleanText(l, 100));
    if (levels.some((l) => !l)) throw new QuestionError("Every level needs a name (up to 100 characters)");
    if (new Set(levels).size !== levels.length) throw new QuestionError("Level names must be different");
    return levels as string[];
  }
  if (criteria === undefined || criteria === null) return null;
  if (typeof criteria !== "object" || Array.isArray(criteria)) throw new QuestionError("A yes/no question's criteria is { true?: …, false?: … }");
  const c = criteria as Record<string, unknown>;
  const yes = c.true === undefined || c.true === "" ? undefined : cleanText(c.true, 300);
  const no = c.false === undefined || c.false === "" ? undefined : cleanText(c.false, 300);
  if (yes === null || no === null) throw new QuestionError("Yes/no descriptions can be up to 300 characters");
  return yes || no ? { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) } : null;
}

/** The Jev question definition for a stored question. */
export function toJevQuestion(q: Pick<TenantQuestion, "type" | "instructions" | "criteria">): JevQuestionDef {
  if (q.type === "choice") return { type: "choice", instructions: q.instructions, criteria: q.criteria as Record<string, string> };
  if (q.type === "score") return { type: "score", instructions: q.instructions, criteria: q.criteria as string[] };
  return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria as { true?: string; false?: string } } : {}) };
}

/** The active custom questions of an organization, as Jev question definitions keyed by their key. */
export async function customQuestionDefs(tenantId: string): Promise<Record<string, JevQuestionDef>> {
  const rows = await prisma.tenantQuestion.findMany({ where: { tenantId, status: "active" }, orderBy: { createdAt: "asc" } });
  return Object.fromEntries(rows.filter((r) => !BUILT_IN_KEYS.has(r.key)).map((r) => [r.key, toJevQuestion(r)]));
}

export async function listQuestions(tenantId: string): Promise<TenantQuestion[]> {
  return prisma.tenantQuestion.findMany({ where: { tenantId, status: "active" }, orderBy: { createdAt: "asc" } });
}

export async function createQuestion(tenantId: string, input: QuestionInput, actor: string): Promise<TenantQuestion> {
  const key = input.key.trim();
  if (!KEY_PATTERN.test(key)) throw new QuestionError("The key must start with a letter and use only lowercase letters, digits and underscores (2–40 characters)");
  if (BUILT_IN_KEYS.has(key)) throw new QuestionError(`"${key}" is one of Eumaeus's built-in questions`);
  if (!(QUESTION_TYPES as readonly string[]).includes(input.type)) throw new QuestionError("type must be noul, choice or score");
  const instructions = cleanText(input.instructions, MAX_INSTRUCTIONS);
  if (!instructions) throw new QuestionError(`The question text is required (up to ${MAX_INSTRUCTIONS} characters)`);
  const criteria = normalizeCriteria(input.type, input.criteria);

  const [count, existing] = await Promise.all([
    prisma.tenantQuestion.count({ where: { tenantId, status: "active" } }),
    prisma.tenantQuestion.findUnique({ where: { tenantId_key: { tenantId, key } } }),
  ]);
  if (count >= MAX_QUESTIONS) throw new QuestionError(`An organization can have at most ${MAX_QUESTIONS} questions`);
  if (existing) throw new QuestionError(existing.status === "deleted" ? `"${key}" was used by a deleted question; choose another key so old analyses keep their meaning` : `A question with the key "${key}" already exists`);

  const created = await prisma.tenantQuestion.create({
    data: { tenantId, key, type: input.type, instructions, criteria: criteria ?? undefined, createdBy: actor },
  });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.QUESTION_CREATED, actor, payload: { questionId: created.id, key, type: input.type } });
  return created;
}

/** Only the wording and the criteria can change — never key or type. Removing a choice option is allowed: a rule comparing against it simply stops matching. */
export async function updateQuestion(tenantId: string, id: string, input: { instructions?: string; criteria?: unknown }, actor: string): Promise<TenantQuestion> {
  const existing = await prisma.tenantQuestion.findFirst({ where: { id, tenantId, status: "active" } });
  if (!existing) throw new QuestionError("Question not found", "not_found");
  const instructions = input.instructions === undefined ? existing.instructions : cleanText(input.instructions, MAX_INSTRUCTIONS);
  if (!instructions) throw new QuestionError(`The question text is required (up to ${MAX_INSTRUCTIONS} characters)`);
  const criteria = input.criteria === undefined ? existing.criteria : normalizeCriteria(existing.type as QuestionType, input.criteria);
  const updated = await prisma.tenantQuestion.update({
    where: { id },
    data: { instructions, criteria: criteria === null ? Prisma.DbNull : (criteria as Prisma.InputJsonValue) },
  });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.QUESTION_UPDATED, actor, payload: { questionId: id, key: existing.key } });
  return updated;
}

/** Names of the active rules and enabled rule graphs whose conditions read answers.<key>. */
export async function questionUsage(tenantId: string, key: string): Promise<string[]> {
  const needle = `"answers.${key}`;
  const [rules, graphs] = await Promise.all([
    prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM rule WHERE tenant_id = ${tenantId} AND deactivated_at IS NULL AND enabled
        AND position(${needle} in conditions::text) > 0`,
    prisma.$queryRaw<Array<{ name: string }>>`
      SELECT DISTINCT g.name FROM rule_node n
        JOIN rule_graph_version v ON v.id = n.graph_version_id
        JOIN rule_graph g ON g.id = v.rule_graph_id
      WHERE n.tenant_id = ${tenantId} AND v.deactivated_at IS NULL AND g.enabled
        AND position(${needle} in n.conditions::text) > 0`,
  ]);
  return [...rules.map((r) => `rule "${r.name}"`), ...graphs.map((g) => `rule graph "${g.name}"`)];
}

/** Soft delete. Refused while an active rule or graph uses the answer, unless forced. */
export async function deleteQuestion(tenantId: string, id: string, actor: string, force = false): Promise<void> {
  const existing = await prisma.tenantQuestion.findFirst({ where: { id, tenantId, status: "active" } });
  if (!existing) throw new QuestionError("Question not found", "not_found");
  const usedBy = await questionUsage(tenantId, existing.key);
  if (usedBy.length > 0 && !force) throw new QuestionError(`answers.${existing.key} is used by ${usedBy.join(", ")}`, "in_use", usedBy);
  await prisma.tenantQuestion.update({ where: { id }, data: { status: "deleted", deletedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.QUESTION_DELETED, actor, payload: { questionId: id, key: existing.key, usedBy } });
}
