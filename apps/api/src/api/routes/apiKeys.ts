import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiKey } from "@prisma/client";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { idParamSchema } from "../schemas/common.js";
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey } from "../../modules/auth/apiKeys.js";

const createBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    permissions: z.array(z.string()).min(1).max(50),
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

export function serializeApiKey(k: ApiKey, now: Date = new Date()) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    permissions: k.permissions,
    createdBy: k.createdBy,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    status: k.revokedAt ? "revoked" : k.expiresAt && k.expiresAt <= now ? "expired" : "active",
  };
}

/** Keys are managed by people only — a key that could mint keys would outlive its own revocation. */
async function rejectApiKeyCallers(request: FastifyRequest): Promise<void> {
  if (request.user?.apiKey) throw new ForbiddenError("API keys can't manage API keys");
}

/** Phase 20: this organization's API keys. The secret is returned once, by POST. */
export function registerApiKeyRoutes(app: FastifyInstance): void {
  const guard = [rejectApiKeyCallers, requirePermission("api_keys:manage")];

  app.get("/api/v1/api-keys", { preHandler: guard }, async (request) => ({ data: (await listApiKeys(request.tenantId)).map((k) => serializeApiKey(k)) }));

  app.post("/api/v1/api-keys", { preHandler: guard }, async (request, reply) => {
    const body = createBodySchema.parse(request.body);
    const membership = request.membership;
    try {
      const { key, apiKey } = await createApiKey(request.tenantId, body, {
        email: request.user!.email,
        isSuperAdmin: request.user!.isSuperAdmin || membership === "ALL",
        permissions: membership && membership !== "ALL" ? membership.permissions : [],
      });
      return reply.status(201).send({ ...serializeApiKey(apiKey), key });
    } catch (error) {
      if (error instanceof ApiKeyError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.delete("/api/v1/api-keys/:id", { preHandler: guard }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const revoked = await revokeApiKey(request.tenantId, params.id, request.user!.email);
    if (!revoked) throw new NotFoundError(`API key ${params.id} not found`);
    return serializeApiKey(revoked);
  });
}
