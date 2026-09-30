import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listReviewsQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(["open", "resolved", "superseded"]).optional(),
    reason: z.enum(["low_confidence", "unmatched", "ambiguous", "failed", "manual_review_requested", "execution_failed", "execution_ambiguous"]).optional(),
    emailId: z.string().min(1).optional(),
    // Phase 28: "me", "none" (unassigned) or a user id.
    assignedTo: z.string().min(1).max(200).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
  })
  .strict();

/** Optional — an empty body still resolves the item exactly as before Phase 10.2 (no resolution recorded). */
export const resolveReviewBodySchema = z
  .object({
    resolution: z.enum(["approved", "spam"]).optional(),
  })
  .strict()
  .optional();

export type ResolveReviewBody = z.infer<typeof resolveReviewBodySchema>;
