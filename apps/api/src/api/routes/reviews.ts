import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParamSchema } from "../schemas/common.js";
import { listReviewsQuerySchema, resolveReviewBodySchema } from "../schemas/reviews.js";
import { getReviewDetail, listReviews, resolveReview } from "../services/reviewService.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { addReviewNote, assignReviewItem, listReviewers, MAX_NOTE_LENGTH, TeamworkError } from "../../modules/review/reviewTeamwork.js";
import { serializeReviewItem } from "../serializers/reviewSerializer.js";
import { findSimilarOpenItems, MAX_SIMILAR, resolveMany } from "../../modules/review/similarReviews.js";

const similarQuerySchema = z.object({ word: z.string().min(1).max(60).optional() }).strict();
const assignSchema = z.object({ userId: z.string().min(1).max(200).nullable() }).strict();
const noteSchema = z.object({ text: z.string().trim().min(1).max(MAX_NOTE_LENGTH) }).strict();

function teamworkError(error: unknown): never {
  if (error instanceof TeamworkError) throw error.code === "not_found" ? new NotFoundError(error.message) : new ValidationError(error.message);
  throw error;
}

const bulkResolveSchema = z.object({ itemIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_SIMILAR), resolution: z.enum(["approved", "spam"]) }).strict();

/**
 * Phase 23: these routes were missing their permission checks — any member of
 * the organization could resolve review items. Reading needs reviews:read,
 * deciding reviews:resolve, and the person deciding is recorded as the actor.
 */
export function registerReviewRoutes(app: FastifyInstance): void {
  app.get("/api/v1/reviews", { preHandler: requirePermission("reviews:read") }, async (request) => {
    const query = listReviewsQuerySchema.parse(request.query);
    // "me" is whoever asks; an API key (no person) has nothing assigned to it.
    const assignedTo = query.assignedTo === "me" ? (request.user?.id ?? "none") : query.assignedTo;
    return listReviews(request.tenantId, { ...query, assignedTo });
  });

  // Phase 28: who an item can be assigned to (members holding reviews:resolve).
  app.get("/api/v1/reviews/assignees", { preHandler: requirePermission("reviews:read") }, async (request) => ({ data: await listReviewers(request.tenantId) }));

  app.post("/api/v1/reviews/:id/assign", { preHandler: requirePermission("reviews:resolve") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = assignSchema.parse(request.body);
    try {
      return serializeReviewItem(await assignReviewItem(request.tenantId, params.id, body.userId, request.user?.email ?? "system"));
    } catch (error) {
      teamworkError(error);
    }
  });

  app.post("/api/v1/reviews/:id/notes", { preHandler: requirePermission("reviews:resolve") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const body = noteSchema.parse(request.body);
    try {
      const note = await addReviewNote(request.tenantId, params.id, body.text, request.user?.email ?? "system");
      return reply.code(201).send(note);
    } catch (error) {
      teamworkError(error);
    }
  });

  app.get("/api/v1/reviews/:id", { preHandler: requirePermission("reviews:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getReviewDetail(request.tenantId, params.id);
  });

  app.post("/api/v1/reviews/:id/resolve", { preHandler: requirePermission("reviews:resolve") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = resolveReviewBodySchema.parse(request.body);
    return resolveReview(request.tenantId, params.id, body?.resolution, request.user?.email ?? "system");
  });

  // The other open items from the same sender (optionally sharing a subject word) — to decide them together.
  app.get("/api/v1/reviews/:id/similar", { preHandler: requirePermission("reviews:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const query = similarQuerySchema.parse(request.query);
    const result = await findSimilarOpenItems(request.tenantId, params.id, query.word);
    if (!result) throw new NotFoundError(`Review item ${params.id} not found`);
    return result;
  });

  app.post("/api/v1/reviews/resolve", { preHandler: requirePermission("reviews:resolve") }, async (request) => {
    const body = bulkResolveSchema.parse(request.body);
    const result = await resolveMany(request.tenantId, body.itemIds, body.resolution, request.user?.email ?? "system");
    return { resolved: result.resolved, skipped: result.skipped, data: result.items.map((item) => serializeReviewItem(item)) };
  });
}
