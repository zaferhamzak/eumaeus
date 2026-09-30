import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";
import { conditionNodeSchema } from "./rules.js";

export const listRuleGraphsQuerySchema = paginationQuerySchema.strict();

// Mirrors modules/rule-graphs/types.ts's BranchTarget exactly — do not
// invent a third variant or reshape either existing one.
const branchTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node"), nodeKey: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("action"), destinationRef: z.string().min(1) }).strict(),
]);

const ruleNodeInputSchema = z
  .object({
    key: z.string().min(1).max(200),
    // Reuses modules/rules' recursive condition AST schema verbatim — never
    // redefined here (§3: "do not duplicate the existing condition AST").
    conditions: conditionNodeSchema,
    onTrue: branchTargetSchema,
    onFalse: branchTargetSchema,
  })
  .strict();

export const ruleGraphInputBodySchema = z
  .object({
    name: z.string().min(1),
    rootNodeKey: z.string().min(1).max(200),
    // A defensive cap, mirroring the condition tree's max(50)-per-group
    // discipline — no true graph in this phase needs anywhere near 200 nodes.
    nodes: z.array(ruleNodeInputSchema).min(1).max(200),
  })
  .strict();

export type RuleGraphInputBody = z.infer<typeof ruleGraphInputBodySchema>;
