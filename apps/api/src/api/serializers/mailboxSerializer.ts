import type { MailboxConnection } from "@prisma/client";

/**
 * Explicit field-by-field serialization (Phase 6 brief §19 — "the serializer is
 * a security boundary"). `providerConfig` is read from the Prisma row only
 * field-by-field, never spread. The password is NEVER read from here at all —
 * it lives in the separate MailboxCredential table (Phase 10), which this
 * serializer never queries; even if it did, there would be no field here that
 * could accidentally surface it, since every field below is named explicitly.
 *
 * `tenantId` is exposed as `organizationId` (Phase 10's public API name for
 * the same underlying row — see schema.prisma's Tenant header comment).
 */
export interface MailboxConnectionResponse {
  id: string;
  organizationId: string;
  name: string | null;
  provider: string;
  emailAddress: string;
  /** Phase 17: "password", "oauth_google" or "oauth_microsoft". */
  authType: string;
  host: string | null;
  port: number | null;
  tls: boolean | null;
  folder: string | null;
  username: string | null;
  ruleGraphId: string | null;
  status: string;
  syncStatus: string;
  lastSyncAttemptAt: string | null;
  lastSyncSuccessAt: string | null;
  lastSyncFailureAt: string | null;
  lastSyncError: string | null;
  lastUidValidity: number | null;
  lastSyncedUid: number | null;
  createdAt: string;
}

interface SafeProviderConfig {
  host?: unknown;
  port?: unknown;
  tls?: unknown;
  folder?: unknown;
  username?: unknown;
}

export function serializeMailboxConnection(row: MailboxConnection): MailboxConnectionResponse {
  const config = (row.providerConfig ?? {}) as SafeProviderConfig;
  return {
    id: row.id,
    organizationId: row.tenantId,
    name: row.name,
    provider: row.provider,
    emailAddress: row.emailAddress,
    authType: row.authType,
    host: typeof config.host === "string" ? config.host : null,
    port: typeof config.port === "number" ? config.port : null,
    tls: typeof config.tls === "boolean" ? config.tls : null,
    folder: typeof config.folder === "string" ? config.folder : null,
    username: typeof config.username === "string" ? config.username : null,
    ruleGraphId: row.ruleGraphId,
    status: row.status,
    syncStatus: row.syncStatus,
    lastSyncAttemptAt: row.lastSyncAttemptAt?.toISOString() ?? null,
    lastSyncSuccessAt: row.lastSyncSuccessAt?.toISOString() ?? null,
    lastSyncFailureAt: row.lastSyncFailureAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    lastUidValidity: row.lastUidValidity,
    lastSyncedUid: row.lastSyncedUid,
    createdAt: row.createdAt.toISOString(),
  };
}
