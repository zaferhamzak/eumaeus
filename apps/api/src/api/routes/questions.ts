import type { FastifyInstance } from "fastify";
import type { TenantQuestion } from "@prisma/client";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { idParamSchema } from "../schemas/common.js";
import {
  createQuestion,
  deleteQuestion,
  listQuestions,
  MAX_QUESTIONS,
  QuestionError,
  questionUsage,
  updateQuestion,
} from "../../modules/questions/tenantQuestions.js";
import { KNOWN_FIELDS } from "../../modules/rules/knownFields.js";
import { customFieldTypes } from "../../modules/rules/customFields.js";

const createSchema = z
  .object({
    key: z.string().min(1).max(40),
    type: z.enum(["noul", "choice", "score"]),
    instructions: z.string().min(1).max(1000),
    criteria: z.unknown().optional(),
  })
  .strict();
const updateSchema = z.object({ instructions: z.string().min(1).max(1000).optional(), criteria: z.unknown().optional() }).strict();
const deleteQuerySchema = z.object({ force: z.enum(["true", "false"]).optional() }).strict();

function serializeQuestion(q: TenantQuestion, usedBy?: string[]) {
  return {
    id: q.id,
    key: q.key,
    field: `answers.${q.key}`,
    type: q.type,
    instructions: q.instructions,
    criteria: q.criteria ?? null,
    createdBy: q.createdBy,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    ...(usedBy ? { usedBy } : {}),
  };
}

function rethrow(error: unknown): never {
  if (error instanceof QuestionError) {
    if (error.kind === "not_found") throw new NotFoundError(error.message);
    if (error.kind === "in_use") throw new ConflictError(error.message, { usedBy: error.usedBy });
    throw new ValidationError(error.message);
  }
  throw error;
}

/**
 * Phase 22: the organization's own Jev questions. Managing them changes what
 * every future email is asked (and what rules can read), so it takes
 * rules:write; reading them, rules:read.
 */
export function registerQuestionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/questions", { preHandler: requirePermission("rules:read") }, async (request) => {
    const rows = await listQuestions(request.tenantId);
    const usage = await Promise.all(rows.map((q) => questionUsage(request.tenantId, q.key)));
    return { data: rows.map((q, i) => serializeQuestion(q, usage[i])), limit: MAX_QUESTIONS };
  });

  app.post("/api/v1/questions", { preHandler: requirePermission("rules:write") }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    try {
      return reply.status(201).send(serializeQuestion(await createQuestion(request.tenantId, body, request.user?.email ?? "system")));
    } catch (error) {
      rethrow(error);
    }
  });

  app.patch("/api/v1/questions/:id", { preHandler: requirePermission("rules:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = updateSchema.parse(request.body);
    try {
      return serializeQuestion(await updateQuestion(request.tenantId, params.id, body, request.user?.email ?? "system"));
    } catch (error) {
      rethrow(error);
    }
  });

  // 409 with { usedBy } while active rules or graphs read the answer; ?force=true deletes anyway.
  app.delete("/api/v1/questions/:id", { preHandler: requirePermission("rules:write") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const query = deleteQuerySchema.parse(request.query);
    try {
      await deleteQuestion(request.tenantId, params.id, request.user?.email ?? "system", query.force === "true");
      return reply.status(204).send();
    } catch (error) {
      rethrow(error);
    }
  });

  // Every field a condition can use in this organization, with its type — the rule editor's list.
  app.get("/api/v1/rules/fields", { preHandler: requirePermission("rules:read") }, async (request) => {
    const custom = await customFieldTypes(request.tenantId);
    const entry = (field: string, type: string, source: "email" | "jev" | "derived" | "custom") => ({ field, type, source });
    const derived = new Set(["email.business_hours", "email.is_reply", "sender.first_email", "sender.emails_last_24h", "sender.spf", "sender.dkim", "sender.dmarc", "sender.authenticated"]);
    return {
      data: [
        ...Object.entries(KNOWN_FIELDS).map(([f, t]) => entry(f, t, f.startsWith("answers.") ? "jev" : derived.has(f) ? "derived" : "email")),
        ...Object.entries(custom).map(([f, t]) => entry(f, t, "custom")),
      ],
    };
  });
}
