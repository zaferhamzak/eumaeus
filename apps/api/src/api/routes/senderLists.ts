import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutingSuggestion, SenderListEntry } from "@prisma/client";
import { idParamSchema } from "../schemas/common.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { prisma } from "../../db/client.js";
import { addSenderEntry, listSenderEntries, removeSenderEntry, SenderListError } from "../../modules/rules/manageSenderList.js";
import { acceptSuggestion, dismissSuggestion, listOpenSuggestions, refreshSuggestions, SuggestionError } from "../../modules/review/suggestions.js";
import { acceptRuleSuggestion, dismissRuleSuggestion, listRuleSuggestions, refreshRuleSuggestions, RuleSuggestionError, type RuleSuggestionView } from "../../modules/review/ruleSuggestions.js";

function serializeEntry(row: SenderListEntry) {
  return { id: row.id, kind: row.kind, pattern: row.pattern, note: row.note, source: row.source, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() };
}

function serializeSuggestion(row: RoutingSuggestion) {
  return {
    id: row.id,
    kind: row.kind,
    pattern: row.pattern,
    resolvedCount: row.resolvedCount,
    spamCount: row.spamCount,
    approvedCount: row.approvedCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const addEntrySchema = z.object({ kind: z.enum(["allow", "block"]), pattern: z.string().min(1).max(320), note: z.string().max(200).optional() }).strict();

/**
 * Phase 16. The allow / block list is routing configuration, so it follows
 * the rules permissions: rules:read to see it and the suggestions,
 * rules:write to change it or act on a suggestion.
 */
export function registerSenderListRoutes(app: FastifyInstance): void {
  app.get("/api/v1/sender-lists", { preHandler: requirePermission("rules:read") }, async (request) => {
    const [entries, tenant] = await Promise.all([
      listSenderEntries(request.tenantId),
      prisma.tenant.findUniqueOrThrow({ where: { id: request.tenantId }, select: { blockDestinationRef: true } }),
    ]);
    return { data: entries.map(serializeEntry), blockDestinationRef: tenant.blockDestinationRef };
  });

  app.post("/api/v1/sender-lists", { preHandler: requirePermission("rules:write") }, async (request, reply) => {
    const body = addEntrySchema.parse(request.body);
    try {
      return reply.status(201).send(serializeEntry(await addSenderEntry(request.tenantId, body, request.user?.email)));
    } catch (error) {
      if (error instanceof SenderListError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.delete("/api/v1/sender-lists/:id", { preHandler: requirePermission("rules:write") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    if (!(await removeSenderEntry(request.tenantId, params.id, request.user?.email))) throw new NotFoundError(`List entry ${params.id} not found`);
    return reply.status(204).send();
  });

  app.get("/api/v1/routing-suggestions", { preHandler: requirePermission("rules:read") }, async (request) => {
    return { data: (await listOpenSuggestions(request.tenantId)).map(serializeSuggestion) };
  });

  // Recomputes from the latest review decisions instead of waiting for the hourly run. Read-only in effect: it only changes proposals.
  app.post("/api/v1/routing-suggestions/refresh", { preHandler: requirePermission("rules:read") }, async (request) => {
    return { data: (await refreshSuggestions(request.tenantId)).map(serializeSuggestion) };
  });

  for (const action of ["accept", "dismiss"] as const) {
    app.post(`/api/v1/routing-suggestions/:id/${action}`, { preHandler: requirePermission("rules:write") }, async (request) => {
      const params = idParamSchema.parse(request.params);
      try {
        const updated = action === "accept" ? await acceptSuggestion(request.tenantId, params.id, request.user?.email) : await dismissSuggestion(request.tenantId, params.id, request.user?.email);
        return serializeSuggestion(updated);
      } catch (error) {
        if (error instanceof SuggestionError) throw new ConflictError(error.message);
        if (error instanceof SenderListError) throw new ConflictError(error.message);
        throw error;
      }
    });
  }

  // Subject-level rule suggestions (a draft rule per sender + subject word), same lifecycle.
  const ruleView = (v: RuleSuggestionView) => ({ ...serializeSuggestion(v.suggestion), sender: v.sender, word: v.word, decision: v.decision, draft: v.draft });
  app.get("/api/v1/rule-suggestions", { preHandler: requirePermission("rules:read") }, async (request) => ({ data: (await listRuleSuggestions(request.tenantId)).map(ruleView) }));
  app.post("/api/v1/rule-suggestions/refresh", { preHandler: requirePermission("rules:read") }, async (request) => {
    await refreshRuleSuggestions(request.tenantId);
    return { data: (await listRuleSuggestions(request.tenantId)).map(ruleView) };
  });
  app.post("/api/v1/rule-suggestions/:id/accept", { preHandler: requirePermission("rules:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = acceptRuleBodySchema.parse(request.body ?? {});
    try {
      const result = await acceptRuleSuggestion(request.tenantId, params.id, request.user?.email, body);
      return { ...serializeSuggestion(result.suggestion), ruleId: result.ruleId, impact: result.impact };
    } catch (error) {
      if (error instanceof RuleSuggestionError) throw new ConflictError(error.message, error.impact ? { impact: error.impact } : undefined);
      throw error;
    }
  });
  app.post("/api/v1/rule-suggestions/:id/dismiss", { preHandler: requirePermission("rules:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    try {
      return serializeSuggestion(await dismissRuleSuggestion(request.tenantId, params.id, request.user?.email));
    } catch (error) {
      if (error instanceof RuleSuggestionError) throw new ConflictError(error.message);
      throw error;
    }
  });
}

const acceptRuleBodySchema = z
  .object({
    destinationRef: z.string().min(1).max(200).optional(),
    priority: z.number().int().optional(),
    name: z.string().min(1).max(200).optional(),
    confirmImpact: z.boolean().optional(),
  })
  .strict();
