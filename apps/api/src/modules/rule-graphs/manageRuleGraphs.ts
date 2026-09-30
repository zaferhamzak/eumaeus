import type { RuleGraph, RuleGraphVersion, RuleNode, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { validateRuleGraph } from "./graphValidation.js";
import { customFieldTypes } from "../rules/customFields.js";
import type { RuleGraphInput } from "./types.js";

export class RuleGraphValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid rule graph configuration: ${errors.join("; ")}`);
    this.name = "RuleGraphValidationError";
  }
}

export interface RuleGraphWithNodes {
  graph: RuleGraph;
  version: RuleGraphVersion;
  nodes: RuleNode[];
}

/**
 * Structural CRUD for graphs. Execution lives in evaluateGraph.ts, invoked
 * from the rule engine for mailboxes that have an enabled graph assigned.
 */
export async function createRuleGraph(tenantId: string, input: RuleGraphInput): Promise<RuleGraphWithNodes> {
  const errors = validateRuleGraph(input, await customFieldTypes(tenantId));
  if (errors.length > 0) throw new RuleGraphValidationError(errors);

  return prisma.$transaction(async (tx) => {
    const graph = await tx.ruleGraph.create({ data: { tenantId, name: input.name, enabled: true } });
    const version = await createVersion(tx, tenantId, graph.id, 1, input);
    const nodes = await tx.ruleNode.findMany({ where: { graphVersionId: version.id } });
    return { graph, version, nodes };
  });
}

/**
 * Versioning, mirroring modules/rules/manageRules.ts's updateRule(): never
 * mutates an existing version's nodes in place. Deactivates the current
 * active version and inserts a brand-new version (with its own fresh
 * RuleNode rows) in one transaction, so a future evaluation record would
 * always be able to point at the exact graph shape that was live at the
 * time — the same guarantee Rule/DestinationChannel already provide.
 */
export async function updateRuleGraph(ruleGraphId: string, input: RuleGraphInput): Promise<RuleGraphWithNodes> {
  const owner = await prisma.ruleGraph.findUniqueOrThrow({ where: { id: ruleGraphId }, select: { tenantId: true } });
  const errors = validateRuleGraph(input, await customFieldTypes(owner.tenantId));
  if (errors.length > 0) throw new RuleGraphValidationError(errors);

  return prisma.$transaction(async (tx) => {
    const graph = await tx.ruleGraph.findUniqueOrThrow({ where: { id: ruleGraphId } });
    const currentVersion = await tx.ruleGraphVersion.findFirst({
      where: { ruleGraphId, deactivatedAt: null },
      orderBy: { version: "desc" },
    });

    if (currentVersion) {
      await tx.ruleGraphVersion.update({ where: { id: currentVersion.id }, data: { deactivatedAt: new Date() } });
    }

    const nextVersionNumber = (currentVersion?.version ?? 0) + 1;
    const version = await createVersion(tx, graph.tenantId, graph.id, nextVersionNumber, input);
    const updatedGraph = await tx.ruleGraph.update({ where: { id: graph.id }, data: { name: input.name } });
    const nodes = await tx.ruleNode.findMany({ where: { graphVersionId: version.id } });
    return { graph: updatedGraph, version, nodes };
  });
}

async function createVersion(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ruleGraphId: string,
  versionNumber: number,
  input: RuleGraphInput,
): Promise<RuleGraphVersion> {
  const version = await tx.ruleGraphVersion.create({
    data: { tenantId, ruleGraphId, version: versionNumber, rootNodeKey: input.rootNodeKey },
  });
  await tx.ruleNode.createMany({
    data: input.nodes.map((node) => ({
      tenantId,
      graphVersionId: version.id,
      key: node.key,
      conditions: node.conditions as never as object,
      onTrue: node.onTrue as never as object,
      onFalse: node.onFalse as never as object,
    })),
  });
  return version;
}

/** Tenant-scoped lookup of a graph + its current active version + that version's nodes. Returns null rather than throwing. */
export async function getRuleGraphById(tenantId: string, ruleGraphId: string): Promise<RuleGraphWithNodes | null> {
  const graph = await prisma.ruleGraph.findFirst({ where: { id: ruleGraphId, tenantId } });
  if (!graph) return null;

  const version = await prisma.ruleGraphVersion.findFirst({
    where: { ruleGraphId, deactivatedAt: null },
    orderBy: { version: "desc" },
  });
  if (!version) return null; // structurally shouldn't happen — every graph has >=1 version from creation onward

  const nodes = await prisma.ruleNode.findMany({ where: { graphVersionId: version.id } });
  return { graph, version, nodes };
}
