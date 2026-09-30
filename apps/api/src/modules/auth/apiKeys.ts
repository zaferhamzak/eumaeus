import { createHash, randomBytes } from "node:crypto";
import type { ApiKey } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { isPermission, type Permission } from "./permissions.js";

/**
 * Phase 20: API keys for scripts and other systems.
 *
 *   format     jm_<8 hex prefix>_<43 char secret>; sent as
 *              "Authorization: Bearer jm_…"
 *   storage    only SHA-256(key) — keys are long random values, so a fast
 *              hash is enough (like invite tokens); the prefix is kept to
 *              tell keys apart on screen
 *   scope      one organization, its own permission list — never more than
 *              the person creating it has there (superAdmin: anything)
 *   lifetime   optional expiry; revoke any time; lastUsedAt is updated at
 *              most once a minute
 */
export const API_KEY_PATTERN = /^jm_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_MS = 60_000;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class ApiKeyError extends Error {}

export interface CreateApiKeyInput {
  name: string;
  permissions: string[];
  expiresInDays?: number | null;
}

export interface Creator {
  email: string;
  isSuperAdmin: boolean;
  /** The creator's own permissions in this organization (ignored for superAdmin). */
  permissions: readonly string[];
}

export async function createApiKey(tenantId: string, input: CreateApiKeyInput, creator: Creator): Promise<{ key: string; apiKey: ApiKey }> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new ApiKeyError("name must be 1–100 characters");
  const permissions = [...new Set(input.permissions)];
  if (permissions.length === 0) throw new ApiKeyError("choose at least one permission");
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length > 0) throw new ApiKeyError(`unknown permission(s): ${unknown.join(", ")}`);
  if (!creator.isSuperAdmin) {
    const beyond = permissions.filter((p) => !creator.permissions.includes(p));
    if (beyond.length > 0) throw new ApiKeyError(`a key can't have permissions you don't have here: ${beyond.join(", ")}`);
  }
  if (input.expiresInDays !== undefined && input.expiresInDays !== null && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 3650)) {
    throw new ApiKeyError("expiresInDays must be between 1 and 3650, or empty for no expiry");
  }

  const prefix = `jm_${randomBytes(4).toString("hex")}`;
  const key = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const apiKey = await prisma.apiKey.create({
    data: {
      tenantId,
      name,
      prefix,
      keyHash: hashApiKey(key),
      permissions: permissions as Permission[],
      createdBy: creator.email,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) : null,
    },
  });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.API_KEY_CREATED, actor: creator.email, payload: { apiKeyId: apiKey.id, name, prefix, permissions } });
  return { key, apiKey };
}

export async function listApiKeys(tenantId: string): Promise<ApiKey[]> {
  return prisma.apiKey.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
}

export async function revokeApiKey(tenantId: string, id: string, actor: string): Promise<ApiKey | null> {
  const existing = await prisma.apiKey.findFirst({ where: { id, tenantId } });
  if (!existing) return null;
  if (existing.revokedAt) return existing;
  const revoked = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.API_KEY_REVOKED, actor, payload: { apiKeyId: id, name: existing.name, prefix: existing.prefix } });
  return revoked;
}

/** The key behind a Bearer token, if it is well-formed, known, not revoked, not expired, and its organization is active. */
export async function resolveApiKey(key: string, now: Date = new Date()): Promise<ApiKey | null> {
  if (!API_KEY_PATTERN.test(key)) return null;
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) }, include: { tenant: { select: { status: true } } } });
  if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= now) || apiKey.tenant.status !== "active") return null;
  if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: now } });
  }
  return { id: apiKey.id, tenantId: apiKey.tenantId, name: apiKey.name, prefix: apiKey.prefix, keyHash: apiKey.keyHash, permissions: apiKey.permissions, createdBy: apiKey.createdBy, createdAt: apiKey.createdAt, expiresAt: apiKey.expiresAt, lastUsedAt: apiKey.lastUsedAt, revokedAt: apiKey.revokedAt };
}
