import type { MailboxConnection } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getSystemSettings } from "../../settings/systemSettings.js";
import { scheduleMailboxSync, unscheduleMailboxSync } from "../../../queue/mailboxSyncQueue.js";
import { setMailboxCredential } from "./mailboxCredentials.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";

export type MailboxConnectionStatus = "active" | "disabled";

export class MailboxValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid mailbox configuration: ${errors.join("; ")}`);
    this.name = "MailboxValidationError";
  }
}

export interface CreateMailboxInput {
  name: string;
  emailAddress: string;
  host: string;
  port: number;
  tls: boolean;
  folder: string;
  username: string;
  password: string;
  /** Must belong to the SAME organization — validated below, never trusted. */
  ruleGraphId?: string;
}

export interface UpdateMailboxInput {
  name?: string;
  status?: MailboxConnectionStatus;
  host?: string;
  port?: number;
  tls?: boolean;
  folder?: string;
  username?: string;
  /** Rotates the mailbox's stored credential when provided. */
  password?: string;
  /** `null` explicitly clears the assignment; `undefined` leaves it unchanged. */
  ruleGraphId?: string | null;
}

function validateCreateInput(input: CreateMailboxInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("name must not be empty");
  if (!input.emailAddress.trim()) errors.push("emailAddress must not be empty");
  if (!input.host.trim()) errors.push("host must not be empty");
  if (!Number.isInteger(input.port) || input.port <= 0) errors.push("port must be a positive integer");
  if (!input.folder.trim()) errors.push("folder must not be empty");
  if (!input.username.trim()) errors.push("username must not be empty");
  if (!input.password) errors.push("password must not be empty");
  return errors;
}

/**
 * A mailbox may reference only a RuleGraph belonging to the SAME
 * organization — validated server-side, never trusted from the client (see
 * this phase's "RULE GRAPH OWNERSHIP" requirement). Looks the graph up by id
 * alone (no tenant filter in the query itself) specifically so a
 * cross-organization reference produces a clear "belongs to a different
 * organization" error rather than an indistinguishable "not found" — useful
 * signal for a future UI/operator, not a security leak (graph ids are
 * unguessable UUIDs, and this endpoint requires the mailbox's own tenant
 * context regardless).
 */
async function assertRuleGraphOwnership(tenantId: string, ruleGraphId: string): Promise<void> {
  const graph = await prisma.ruleGraph.findUnique({ where: { id: ruleGraphId } });
  if (!graph) throw new MailboxValidationError([`no rule graph "${ruleGraphId}" exists`]);
  if (graph.tenantId !== tenantId) {
    throw new MailboxValidationError([`rule graph "${ruleGraphId}" belongs to a different organization`]);
  }
}

/**
 * Real per-mailbox creation (replaces the Phase 6 "createMailboxUnsupported"
 * 501 — see api/services/mailboxService.ts). Creates the MailboxConnection
 * row and its encrypted credential together; schedules reconciliation
 * immediately (mirrors the existing live-scheduling behavior status changes
 * already had) rather than waiting for the next worker restart.
 */
export async function createMailboxConnection(tenantId: string, input: CreateMailboxInput): Promise<MailboxConnection> {
  const errors = validateCreateInput(input);
  if (errors.length > 0) throw new MailboxValidationError(errors);
  if (input.ruleGraphId) await assertRuleGraphOwnership(tenantId, input.ruleGraphId);

  const mailbox = await prisma.mailboxConnection.create({
    data: {
      tenantId,
      name: input.name,
      provider: "imap",
      emailAddress: input.emailAddress,
      ruleGraphId: input.ruleGraphId,
      providerConfig: { host: input.host, port: input.port, tls: input.tls, folder: input.folder, username: input.username },
      status: "active",
    },
  });

  // Credential is stored AFTER the row exists (setMailboxCredential looks the
  // mailbox up first) — never inline in providerConfig, per §"MAILBOX
  // CREDENTIALS": encrypted at rest via the same mechanism DestinationSecret
  // already uses, independently stored per mailbox.
  await setMailboxCredential(tenantId, mailbox.id, input.password);

  const settings = await getSystemSettings();
  await scheduleMailboxSync(mailbox.id, settings.mailboxSyncIntervalSeconds * 1000);

  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.MAILBOX_CREATED,
    actor: "system",
    payload: { mailboxConnectionId: mailbox.id, emailAddress: mailbox.emailAddress, ruleGraphId: input.ruleGraphId ?? null },
  });

  return mailbox;
}

/**
 * General mailbox update — status, display name, connection config, a
 * credential rotation, and/or rule graph assignment, in one call. Replaces
 * the narrower Phase 6 setMailboxConnectionStatus() (status-only); the live
 * schedule/unschedule side effect on a status change is preserved exactly.
 *
 * Returns null if no such mailbox exists for this tenant — same contract as
 * every other tenant-scoped lookup in this codebase.
 */
export async function updateMailboxConnection(
  tenantId: string,
  mailboxConnectionId: string,
  input: UpdateMailboxInput,
): Promise<MailboxConnection | null> {
  const existing = await prisma.mailboxConnection.findFirst({ where: { id: mailboxConnectionId, tenantId } });
  if (!existing) return null;

  // Phase 17: an OAuth mailbox's server and sign-in belong to the provider;
  // to change them, connect again.
  if (existing.authType !== "password") {
    const fixed = (["host", "port", "tls", "username", "password"] as const).filter((k) => input[k] !== undefined);
    if (fixed.length > 0) throw new MailboxValidationError([`${fixed.join(", ")} can't be changed on a mailbox connected with Google or Microsoft — connect it again instead`]);
  }

  if (input.ruleGraphId) await assertRuleGraphOwnership(tenantId, input.ruleGraphId);

  const currentConfig = existing.providerConfig as { host: string; port: number; tls: boolean; folder: string; username: string };
  const nextConfig = {
    host: input.host ?? currentConfig.host,
    port: input.port ?? currentConfig.port,
    tls: input.tls ?? currentConfig.tls,
    folder: input.folder ?? currentConfig.folder,
    username: input.username ?? currentConfig.username,
  };

  // A new password for a mailbox waiting on one (its sign-in kept being
  // rejected) puts it back to work, unless this same call says otherwise.
  const resume = Boolean(input.password) && existing.status === "reauth_required" && input.status === undefined;
  const status = input.status ?? (resume ? "active" : undefined);

  const updated = await prisma.mailboxConnection.update({
    where: { id: mailboxConnectionId },
    data: {
      name: input.name ?? undefined,
      status,
      providerConfig: nextConfig,
      // `null` clears the FK; `undefined` leaves it untouched — Prisma
      // distinguishes these, so this must not collapse `null` into a no-op.
      ruleGraphId: input.ruleGraphId === undefined ? undefined : input.ruleGraphId,
    },
  });

  if (status !== undefined) {
    if (status === "active") {
      const settings = await getSystemSettings();
      await scheduleMailboxSync(mailboxConnectionId, settings.mailboxSyncIntervalSeconds * 1000);
    } else {
      await unscheduleMailboxSync(mailboxConnectionId);
    }
  }

  if (input.password) {
    await setMailboxCredential(tenantId, mailboxConnectionId, input.password);
  }

  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.MAILBOX_UPDATED,
    actor: "system",
    payload: { mailboxConnectionId },
  });
  if (input.ruleGraphId !== undefined) {
    await recordAuditEvent(prisma, {
      tenantId,
      eventType: AuditEventType.MAILBOX_RULE_GRAPH_ASSIGNED,
      actor: "system",
      payload: { mailboxConnectionId, ruleGraphId: input.ruleGraphId },
    });
  }

  return updated;
}

/**
 * Soft — sets status="disabled" and unschedules reconciliation, exactly what
 * PATCH { status: "disabled" } already did. Real per-mailbox DELETE, unlike
 * Phase 6's 501: Email/AuditEvent history still references this row and
 * remains fully intact and queryable — nothing is removed. Idempotent.
 */
export async function deactivateMailboxConnection(tenantId: string, mailboxConnectionId: string): Promise<MailboxConnection | null> {
  const existing = await prisma.mailboxConnection.findFirst({ where: { id: mailboxConnectionId, tenantId } });
  if (!existing) return null;
  if (existing.status === "disabled") return existing;

  const updated = await prisma.mailboxConnection.update({ where: { id: mailboxConnectionId }, data: { status: "disabled" } });
  await unscheduleMailboxSync(mailboxConnectionId);
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.MAILBOX_DEACTIVATED,
    actor: "system",
    payload: { mailboxConnectionId },
  });
  return updated;
}

/**
 * Phase 17: creates a mailbox signed in with Google / Microsoft (no password —
 * its tokens live in MailboxOAuthToken, stored by the caller), or, when this
 * organization already has a mailbox for the same address, reconnects that
 * one (back to "active"). Does NOT schedule sync: the caller stores the new
 * tokens first, then schedules, so no sync can run with the old ones.
 */
export async function upsertOAuthMailboxConnection(
  tenantId: string,
  input: { authType: "oauth_google" | "oauth_microsoft"; emailAddress: string; name?: string; folder: string; imap: { host: string; port: number; tls: boolean }; mailboxConnectionId?: string },
): Promise<{ mailbox: MailboxConnection; created: boolean }> {
  const existing = input.mailboxConnectionId
    ? await prisma.mailboxConnection.findFirst({ where: { id: input.mailboxConnectionId, tenantId } })
    : await prisma.mailboxConnection.findFirst({ where: { tenantId, emailAddress: input.emailAddress, authType: input.authType, status: { not: "disabled" } } });

  if (existing) {
    if (existing.emailAddress.toLowerCase() !== input.emailAddress.toLowerCase()) {
      throw new MailboxValidationError([`You signed in as ${input.emailAddress}, but this mailbox is ${existing.emailAddress}. Sign in with that account.`]);
    }
    const mailbox = await prisma.mailboxConnection.update({ where: { id: existing.id }, data: { status: "active", authType: input.authType, lastSyncError: null } });
    return { mailbox, created: false };
  }

  const mailbox = await prisma.mailboxConnection.create({
    data: {
      tenantId,
      name: input.name ?? input.emailAddress,
      provider: "imap",
      authType: input.authType,
      emailAddress: input.emailAddress,
      providerConfig: { ...input.imap, folder: input.folder, username: input.emailAddress },
      status: "active",
    },
  });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.MAILBOX_CREATED,
    actor: "system",
    payload: { mailboxConnectionId: mailbox.id, emailAddress: mailbox.emailAddress, authType: input.authType },
  });
  return { mailbox, created: true };
}
