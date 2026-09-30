import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";
import { ValidationError } from "../errors/ApiError.js";
import { ErasureError, eraseSender } from "../../modules/privacy/retention.js";

const eraseSenderBodySchema = z.object({ address: z.string().min(3).max(320), dryRun: z.boolean().default(true) }).strict();

/**
 * Phase 20: KVKK/GDPR — erase what this organization holds about one sender.
 * dryRun (the default) only counts; the real run can't be undone.
 */
export function registerPrivacyRoutes(app: FastifyInstance): void {
  app.post("/api/v1/privacy/erase-sender", { preHandler: requirePermission("privacy:erase") }, async (request) => {
    const body = eraseSenderBodySchema.parse(request.body);
    try {
      return await eraseSender(request.tenantId, body.address, { dryRun: body.dryRun }, request.user?.email);
    } catch (error) {
      if (error instanceof ErasureError) throw new ValidationError(error.message);
      throw error;
    }
  });
}
