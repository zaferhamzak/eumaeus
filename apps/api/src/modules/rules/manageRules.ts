import { randomUUID } from "node:crypto";
import type { Rule, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { validateRule, type RuleInput } from "./validateRule.js";
import { customFieldTypes } from "./customFields.js";

export class RuleValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid rule configuration: ${errors.join("; ")}`);
    this.name = "RuleValidationError";
  }
}

/**
 * There is no HTTP/rule-builder UI yet (out of scope for this phase) — these are
 * the functions such a UI (or a seed script, or a test) calls. Rejects an invalid
 * rule outright rather than persisting it disabled-and-broken; see validateRule.ts.
 */
export async function createRule(tenantId: string, input: RuleInput): Promise<Rule> {
  const errors = validateRule(input, await customFieldTypes(tenantId));
  if (errors.length > 0) throw new RuleValidationError(errors);

  await assertPriorityAvailable(tenantId, input.priority);

  // A new rule starts its own lineage (Phase 25): its id is its lineage id.
  const id = randomUUID();
  return prisma.rule.create({
    data: {
      id,
      lineageId: id,
      tenantId,
      name: input.name,
      priority: input.priority,
      destinationRef: input.destinationRef,
      conditions: input.conditions as never as object,
      enabled: true,
      version: 1,
    },
  });
}

/**
 * Versioning (this phase's §5/§7 — "which rule version/configuration was used"
 * must be answerable forever): never mutates an existing row's conditions in
 * place. Deactivates the old row and inserts a new one with version+1, in one
 * transaction, so no RuleEvaluation ever ends up pointing at a row whose content
 * changed after the fact.
 */
export async function updateRule(ruleId: string, input: RuleInput): Promise<Rule> {
  const owner = await prisma.rule.findUniqueOrThrow({ where: { id: ruleId }, select: { tenantId: true } });
  const errors = validateRule(input, await customFieldTypes(owner.tenantId));
  if (errors.length > 0) throw new RuleValidationError(errors);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.rule.findUniqueOrThrow({ where: { id: ruleId } });

    await tx.rule.update({
      where: { id: ruleId },
      data: { enabled: false, deactivatedAt: new Date() },
    });

    await assertPriorityAvailable(existing.tenantId, input.priority, tx);

    return tx.rule.create({
      data: {
        tenantId: existing.tenantId,
        name: input.name,
        priority: input.priority,
        destinationRef: input.destinationRef,
        conditions: input.conditions as never as object,
        enabled: true,
        version: existing.version + 1,
        lineageId: existing.lineageId ?? existing.id,
      },
    });
  });
}

/**
 * Phase 25: brings a deleted rule back as a new version of its own lineage
 * (history stays one chain). Same validation and priority check as creating.
 */
export async function restoreRule(tenantId: string, lineageId: string, input: RuleInput): Promise<Rule> {
  const errors = validateRule(input, await customFieldTypes(tenantId));
  if (errors.length > 0) throw new RuleValidationError(errors);
  await assertPriorityAvailable(tenantId, input.priority);
  const last = await prisma.rule.findFirst({ where: { tenantId, OR: [{ lineageId }, { id: lineageId }] }, orderBy: { version: "desc" } });
  return prisma.rule.create({
    data: {
      tenantId,
      lineageId,
      name: input.name,
      priority: input.priority,
      destinationRef: input.destinationRef,
      conditions: input.conditions as never as object,
      enabled: true,
      version: (last?.version ?? 0) + 1,
    },
  });
}

export async function listActiveRules(tenantId: string): Promise<Rule[]> {
  return prisma.rule.findMany({
    where: { tenantId, enabled: true, deactivatedAt: null },
    orderBy: { priority: "asc" },
  });
}

/** Tenant-scoped single lookup — Phase 6's Control Plane API (GET/PATCH/DELETE /rules/:id all need this, not just the Rule Engine's own listActiveRules). Returns null rather than throwing; callers decide what "not found" means for their context. */
export async function getRuleById(tenantId: string, ruleId: string): Promise<Rule | null> {
  return prisma.rule.findFirst({ where: { id: ruleId, tenantId } });
}

/**
 * Phase 6: the Control Plane API's DELETE /rules/:id. There is no hard delete —
 * RuleEvaluation/RoutingDecision history references a rule version and must
 * remain resolvable — so "delete" means the same deactivation updateRule()
 * already performs on the OLD version during an edit, applied directly instead
 * of paired with creating a new version. Idempotent: deactivating an
 * already-inactive rule is a no-op that still returns it, not an error.
 */
export async function deactivateRule(tenantId: string, ruleId: string): Promise<Rule | null> {
  const existing = await prisma.rule.findFirst({ where: { id: ruleId, tenantId } });
  if (!existing) return null;
  if (!existing.enabled) return existing;
  return prisma.rule.update({ where: { id: ruleId }, data: { enabled: false, deactivatedAt: new Date() } });
}

async function assertPriorityAvailable(
  tenantId: string,
  priority: number,
  client: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<void> {
  const conflict = await client.rule.findFirst({ where: { tenantId, priority, enabled: true, deactivatedAt: null } });
  if (conflict) {
    throw new RuleValidationError([`priority ${priority} is already used by active rule "${conflict.name}" (${conflict.id})`]);
  }
}
