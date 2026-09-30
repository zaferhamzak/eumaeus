import { z } from "zod";

/**
 * Shared across every resource's `:id` param. Deliberately not a strict UUID
 * regex — every id in this schema is `@id @default(uuid())`, but validating
 * "non-empty, reasonably bounded string" is enough to reject garbage input
 * before it reaches a Prisma query, without this schema having to track the
 * exact id format if that ever changes.
 */
export const idParamSchema = z.object({
  id: z.string().min(1).max(200),
});

export type IdParam = z.infer<typeof idParamSchema>;

/** `:id/:name` — used by the destination-secret routes (a secret is addressed by name, not id). */
export const idAndNameParamSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});

/** `:id/:membershipId` — used by the organization-member routes (`:id` is the organization, `:membershipId` the Membership row within it). */
export const idAndMembershipIdParamSchema = z.object({
  id: z.string().min(1).max(200),
  membershipId: z.string().min(1).max(200),
});
