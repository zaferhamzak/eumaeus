import { prisma } from "../../db/client.js";
import type { FieldType } from "./knownFields.js";

/**
 * Phase 22: the rule fields an organization's own Jev questions add, with
 * their value types — answers.<key> (and answers.<key>.confidence for choice
 * and score, like the built-in ones). Read straight from the question rows so
 * the rules module stays independent of modules/questions and modules/jev.
 */
export type ExtraFields = Record<string, FieldType>;

export function fieldsForQuestions(questions: Array<{ key: string; type: string }>): ExtraFields {
  const fields: ExtraFields = {};
  for (const q of questions) {
    if (q.type === "noul") fields[`answers.${q.key}`] = "number";
    if (q.type === "choice") {
      fields[`answers.${q.key}`] = "string";
      fields[`answers.${q.key}.confidence`] = "number";
    }
    if (q.type === "score") {
      fields[`answers.${q.key}`] = "number";
      fields[`answers.${q.key}.confidence`] = "number";
    }
  }
  return fields;
}

export async function customFieldTypes(tenantId: string): Promise<ExtraFields> {
  const rows = await prisma.tenantQuestion.findMany({ where: { tenantId, status: "active" }, select: { key: true, type: true } });
  return fieldsForQuestions(rows);
}
