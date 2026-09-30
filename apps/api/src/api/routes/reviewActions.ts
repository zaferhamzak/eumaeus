import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ForbiddenError, ValidationError } from "../errors/ApiError.js";
import { confirmReviewAction, previewReviewAction, ReviewActionError } from "../../modules/review/reviewActionTokens.js";

const tokenSchema = z.object({ token: z.string().min(10).max(2000) }).strict();

function rethrow(error: unknown): never {
  if (error instanceof ReviewActionError) {
    if (error.code === "forbidden") throw new ForbiddenError(error.message);
    throw new ValidationError(error.message);
  }
  throw error;
}

/**
 * Phase 23: the one-click decision links in the review digest. Outside the
 * organization scope (the link is opened from an email, possibly without a
 * session); the signed token names the organization, item, decision and
 * recipient. GET only shows what would happen; POST (the confirmation page's
 * button) decides.
 */
export function registerReviewActionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/review-actions/preview", async (request) => {
    const { token } = tokenSchema.parse(request.query);
    try {
      return await previewReviewAction(token);
    } catch (error) {
      rethrow(error);
    }
  });

  app.post("/api/v1/review-actions", async (request) => {
    const { token } = tokenSchema.parse(request.body);
    try {
      return await confirmReviewAction(token);
    } catch (error) {
      rethrow(error);
    }
  });
}
