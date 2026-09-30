import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listRulesQuerySchema = paginationQuerySchema
  .extend({
    enabled: z.enum(["true", "false"]).optional(),
  })
  .strict();

const comparisonOpSchema = z.enum(["==", "!=", ">=", "<=", ">", "<", "in", "contains"]);
const conditionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);

const conditionLeafSchema = z
  .object({
    field: z.string().min(1),
    op: comparisonOpSchema,
    value: conditionValueSchema,
  })
  .strict();

// Recursive AST — mirrors modules/rules/conditions.ts's ConditionNode exactly
// (§10: "do not invent new rule operators"). z.lazy() is required since the
// group/NOT variants reference the whole node type recursively.
export interface ConditionNodeInput {
  field?: string;
  op?: string;
  value?: unknown;
  children?: ConditionNodeInput[];
  child?: ConditionNodeInput;
}

export const conditionNodeSchema: z.ZodType<ConditionNodeInput> = z.lazy(() =>
  z.union([
    conditionLeafSchema,
    z.object({ op: z.enum(["AND", "OR"]), children: z.array(conditionNodeSchema).max(50) }).strict(),
    z.object({ op: z.literal("NOT"), child: conditionNodeSchema }).strict(),
  ]),
);

export const ruleInputBodySchema = z
  .object({
    name: z.string().min(1),
    priority: z.number().int(),
    conditions: conditionNodeSchema,
    destinationRef: z.string().min(1),
  })
  .strict();

export type RuleInputBody = z.infer<typeof ruleInputBodySchema>;

/** Create/update body: the rule plus, for a change flagged as risky by the impact check, an explicit confirmation. */
export const ruleSaveBodySchema = ruleInputBodySchema.extend({ confirmImpact: z.boolean().optional() }).strict();

export const ruleImpactBodySchema = z
  .object({
    change: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create"), rule: ruleInputBodySchema }).strict(),
      z.object({ type: z.literal("update"), ruleId: z.string().min(1), rule: ruleInputBodySchema }).strict(),
      z.object({ type: z.literal("delete"), ruleId: z.string().min(1) }).strict(),
    ]),
    days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const importedRuleSchema = z
  .object({
    name: z.string().min(1).max(200),
    priority: z.number().int(),
    conditions: conditionNodeSchema,
    destinationRef: z.string().min(1).max(200),
  })
  .strict();

/** The file POST /rules/import accepts: an export envelope (extra fields ignored) or a bare array of rules. */
export const ruleImportBodySchema = z
  .object({
    rules: z.union([
      z.array(importedRuleSchema),
      z.object({ format: z.enum(["eumaeus.rules", "jevmail.rules"]), version: z.literal(1), rules: z.array(importedRuleSchema) }).passthrough(),
    ]),
    mode: z.enum(["add", "replace"]).default("add"),
    priorities: z.enum(["keep", "append"]).default("keep"),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .transform(({ rules, ...rest }) => ({ ...rest, rules: Array.isArray(rules) ? rules : rules.rules }))
  .refine((b) => b.rules.length >= 1 && b.rules.length <= 500, "the file must contain between 1 and 500 rules");
