import { z } from "zod";
import { paginationQuerySchema } from "../pagination.js";

export const listMailboxesQuerySchema = paginationQuerySchema
  .extend({
    // When provided, lists THAT organization's mailboxes instead of
    // request.tenantId's — same explicitly-trusted-reference pattern as
    // createMailboxBodySchema's organizationId (see that field's comment).
    // Read-only, so this does not reopen the cross-organization WRITE
    // protection PATCH/DELETE still enforce via request.tenantId.
    organizationId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const createMailboxBodySchema = z
  .object({
    // Validated to reference a real, existing Organization — see
    // api/services/mailboxService.ts. See this phase's report for why this
    // is trusted directly from the body rather than request.tenantId: there
    // is no auth yet to derive "which organization is this caller" from, and
    // multi-organization creation needs SOME way to pick a target
    // organization until one exists.
    organizationId: z.string().min(1).max(200),
    name: z.string().min(1),
    email: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    tls: z.boolean(),
    folder: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    ruleGraphId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const updateMailboxBodySchema = z
  .object({
    status: z.enum(["active", "disabled"]).optional(),
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    tls: z.boolean().optional(),
    folder: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    // `null` explicitly clears the rule graph assignment; omitted leaves it unchanged.
    ruleGraphId: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

export type ListMailboxesQuery = z.infer<typeof listMailboxesQuerySchema>;
export type CreateMailboxBody = z.infer<typeof createMailboxBodySchema>;
export type UpdateMailboxBody = z.infer<typeof updateMailboxBodySchema>;
