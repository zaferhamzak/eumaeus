import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParamSchema } from "../schemas/common.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { InvalidStateError, NotFoundError } from "../errors/ApiError.js";
import { serializeRoutingDecision } from "../serializers/routingDecisionSerializer.js";
import { reprocessEmail, ReprocessRefusedError } from "../../modules/reprocess/reprocessEmail.js";

const bulkSchema = z.object({ emailIds: z.array(z.string().min(1).max(200)).min(1).max(100), reanalyze: z.boolean().default(false) }).strict();
// Phase 22: reanalyze = ask Jev again first (billed; picks up new questions).
const singleSchema = z.object({ reanalyze: z.boolean().default(false) }).strict();

/**
 * Phase 18. Reprocessing runs actions again (moves, forwards, webhooks), so it
 * has its own permission, emails:reprocess. The preview is POST /simulations
 * with target {type:"current"} and scope.emailIds — read-only.
 */
export function registerReprocessRoutes(app: FastifyInstance): void {
  app.post("/api/v1/emails/:id/reprocess", { preHandler: requirePermission("emails:reprocess") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    try {
      const body = singleSchema.parse(request.body ?? {});
      const result = await reprocessEmail(request.tenantId, params.id, request.user?.email ?? "system", { reanalyze: body.reanalyze });
      return { emailId: result.emailId, previousDecisionId: result.previousDecisionId, decision: serializeRoutingDecision(result.decision) };
    } catch (error) {
      if (error instanceof ReprocessRefusedError) {
        if (error.code === "not_found") throw new NotFoundError(error.message);
        throw new InvalidStateError(error.message);
      }
      throw error;
    }
  });

  // One at a time, in order: each email's actions are dispatched before the next starts.
  app.post("/api/v1/emails/reprocess", { preHandler: requirePermission("emails:reprocess") }, async (request) => {
    const body = bulkSchema.parse(request.body);
    const results = [];
    for (const emailId of [...new Set(body.emailIds)]) {
      try {
        const r = await reprocessEmail(request.tenantId, emailId, request.user?.email ?? "system", { reanalyze: body.reanalyze });
        results.push({ emailId, status: "reprocessed" as const, decisionStatus: r.decision.status, destinationRef: r.decision.destinationRef });
      } catch (error) {
        if (!(error instanceof ReprocessRefusedError)) throw error;
        results.push({ emailId, status: "refused" as const, reason: error.code, message: error.message });
      }
    }
    return { results };
  });
}
