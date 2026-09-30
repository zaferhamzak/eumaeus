import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParamSchema } from "../schemas/common.js";
import { requirePermission } from "../plugins/requirePermission.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import {
  listForwardRecipients,
  resendForwardVerification,
  revokeForwardRecipient,
  verifyForwardRecipient,
} from "../../modules/destinations/forwardRecipients.js";
import type { ForwardRecipient } from "@prisma/client";

export interface ForwardRecipientResponse {
  id: string;
  address: string;
  status: string;
  requestedBy: string | null;
  verifiedAt: string | null;
  linkExpiresAt: string | null;
  createdAt: string;
}

function serialize(row: ForwardRecipient): ForwardRecipientResponse {
  return {
    id: row.id,
    address: row.address,
    status: row.status,
    requestedBy: row.requestedBy,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    linkExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Tenant-scoped management of forward recipients (Phase 13.3). Recipients are created by saving a forward channel, never directly. */
export function registerForwardRecipientRoutes(app: FastifyInstance): void {
  app.get("/api/v1/forward-recipients", { preHandler: requirePermission("destinations:read") }, async (request) => {
    return { data: (await listForwardRecipients(request.tenantId)).map(serialize) };
  });

  app.post("/api/v1/forward-recipients/:id/resend", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const result = await resendForwardVerification(request.tenantId, params.id, request.user?.email);
    if (!result) throw new NotFoundError(`Forward recipient ${params.id} not found`);
    return { recipient: serialize(result.recipient), emailSent: result.emailSent };
  });

  app.delete("/api/v1/forward-recipients/:id", { preHandler: requirePermission("destinations:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const revoked = await revokeForwardRecipient(request.tenantId, params.id, request.user?.email);
    if (!revoked) throw new NotFoundError(`Forward recipient ${params.id} not found`);
    return serialize(revoked);
  });
}

const verifyBodySchema = z.object({ token: z.string().min(1).max(200) }).strict();

/**
 * Public — the recipient following the emailed link isn't a Eumaeus user.
 * The token is the only credential, so it's registered outside the tenant
 * scope, like the auth routes.
 */
export function registerForwardVerificationRoute(app: FastifyInstance): void {
  app.post("/api/v1/forward-recipients/verify", async (request) => {
    const body = verifyBodySchema.parse(request.body);
    const result = await verifyForwardRecipient(body.token);
    if (!result.ok) {
      throw new ValidationError(result.reason === "expired" ? "This confirmation link has expired. Ask the organization to send a new one." : "This confirmation link is not valid or was already used.");
    }
    return { address: result.address, organizationName: result.organizationName };
  });
}
