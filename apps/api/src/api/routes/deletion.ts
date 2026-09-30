import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParamSchema } from "../schemas/common.js";
import { requirePermission, requireSuperAdmin } from "../plugins/requirePermission.js";
import { InvalidStateError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { serializeOrganization } from "../serializers/organizationSerializer.js";
import {
  DeletionError,
  deleteEmails,
  deleteMailboxPermanently,
  deleteOrganizationPermanently,
  MAX_EMAILS_PER_DELETE,
  reactivateOrganization,
} from "../../modules/tenancy/deletion.js";

const confirmOrgSchema = z.object({ confirmName: z.string().min(1).max(300) }).strict();
const confirmMailboxSchema = z.object({ confirmAddress: z.string().min(1).max(320) }).strict();
const deleteEmailsSchema = z.object({ emailIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_EMAILS_PER_DELETE) }).strict();

function rethrow(error: unknown): never {
  if (error instanceof DeletionError) {
    if (error.code === "not_found") throw new NotFoundError(error.message);
    if (error.code === "still_active") throw new InvalidStateError(error.message);
    throw new ValidationError(error.message);
  }
  throw error;
}

/**
 * Reactivating an organization, and permanent deletion (see
 * modules/tenancy/deletion.ts). Deleting an organization or a mailbox is for
 * the system administrator only and needs the name/address typed back;
 * deleting selected emails needs privacy:erase, the KVKK erasure permission.
 */
export function registerDeletionRoutes(app: FastifyInstance): void {
  app.post("/api/v1/organizations/:id/reactivate", { preHandler: requirePermission("organizations:delete", { paramName: "id" }) }, async (request) => {
    const params = idParamSchema.parse(request.params);
    try {
      return serializeOrganization(await reactivateOrganization(params.id, request.user?.email ?? "system"));
    } catch (error) {
      rethrow(error);
    }
  });

  app.post("/api/v1/organizations/:id/delete-permanently", { preHandler: requireSuperAdmin }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = confirmOrgSchema.parse(request.body);
    try {
      return await deleteOrganizationPermanently(params.id, body.confirmName, { id: request.user!.id, email: request.user!.email });
    } catch (error) {
      rethrow(error);
    }
  });

  app.post("/api/v1/mailboxes/:id/delete-permanently", { preHandler: requireSuperAdmin }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = confirmMailboxSchema.parse(request.body);
    try {
      return await deleteMailboxPermanently(request.tenantId, params.id, body.confirmAddress, request.user?.email ?? "system");
    } catch (error) {
      rethrow(error);
    }
  });

  app.post("/api/v1/emails/delete", { preHandler: requirePermission("privacy:erase") }, async (request) => {
    const body = deleteEmailsSchema.parse(request.body);
    return deleteEmails(request.tenantId, body.emailIds, request.user?.email ?? "system");
  });
}
