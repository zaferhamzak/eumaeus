import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParamSchema } from "../schemas/common.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { InvalidStateError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { serializeRoutingDecision } from "../serializers/routingDecisionSerializer.js";
import { correctEmail, correctionRuleDraft, CorrectionError } from "../../modules/corrections/correctEmail.js";

const correctBodySchema = z.object({ destinationRef: z.string().min(1).max(200) }).strict();
const draftQuerySchema = z.object({ destinationRef: z.string().min(1).max(200), wrong: z.string().min(1).max(200).optional() }).strict();

function rethrow(error: unknown): never {
  if (error instanceof CorrectionError) {
    if (error.code === "not_found") throw new NotFoundError(error.message);
    if (error.code === "unknown_destination") throw new ValidationError(error.message);
    throw new InvalidStateError(error.message);
  }
  throw error;
}

/**
 * Phase 24: put an email where it belongs (destinationRef = a destination
 * name, or "inbox"). Moves mail and replaces the decision, so it takes the
 * same permission as reprocessing. The rule draft is read-only (rules:read).
 */
export function registerCorrectionRoutes(app: FastifyInstance): void {
  app.post("/api/v1/emails/:id/correct", { preHandler: requirePermission("emails:reprocess") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = correctBodySchema.parse(request.body);
    try {
      const result = await correctEmail(request.tenantId, params.id, body.destinationRef, request.user?.email ?? "system");
      return {
        previousDestination: result.previous ? (result.previous.status === "matched" ? result.previous.destinationRef : result.previous.status === "sender_allowed" ? "left_alone" : "human_review") : null,
        movedBack: result.undone,
        decision: serializeRoutingDecision(result.decision),
      };
    } catch (error) {
      rethrow(error);
    }
  });

  app.get("/api/v1/emails/:id/correction-rule", { preHandler: requirePermission("rules:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const query = draftQuerySchema.parse(request.query);
    try {
      return await correctionRuleDraft(request.tenantId, params.id, query.destinationRef, query.wrong ?? null);
    } catch (error) {
      rethrow(error);
    }
  });
}
