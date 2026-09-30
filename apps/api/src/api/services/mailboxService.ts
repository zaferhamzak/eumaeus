import { prisma } from "../../db/client.js";
import {
  createMailboxConnection,
  updateMailboxConnection,
  deactivateMailboxConnection,
  MailboxValidationError,
} from "../../modules/mail-providers/imap/manageMailboxConnections.js";
import { enqueueMailboxReconciliation } from "../../queue/mailboxSyncQueue.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { paginateByCursor, type CursorPage } from "../pagination.js";
import { serializeMailboxConnection, type MailboxConnectionResponse } from "../serializers/mailboxSerializer.js";
import type { CreateMailboxBody, ListMailboxesQuery, UpdateMailboxBody } from "../schemas/mailboxes.js";

/**
 * `query.organizationId`, when provided, is trusted directly and OVERRIDES
 * `tenantId` (the request's implicit "current" organization) — the same
 * explicit-reference-trusted pattern createMailbox() already uses, extended
 * to this read-only listing so a UI can browse a SPECIFIC organization's
 * mailboxes regardless of which one the no-auth request context happens to
 * resolve to. See schemas/mailboxes.ts's organizationId comment.
 */
export async function listMailboxes(tenantId: string, query: ListMailboxesQuery): Promise<CursorPage<MailboxConnectionResponse>> {
  const scopeTenantId = query.organizationId ?? tenantId;
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.mailboxConnection.findMany({
      where: { tenantId: scopeTenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeMailboxConnection) };
}

export async function getMailboxById(tenantId: string, id: string): Promise<MailboxConnectionResponse> {
  const row = await prisma.mailboxConnection.findFirst({ where: { id, tenantId } });
  if (!row) throw new NotFoundError(`Mailbox ${id} not found`);
  return serializeMailboxConnection(row);
}

/**
 * Phase 10: real creation (replaces the Phase 6 "createMailboxUnsupported"
 * 501). `body.organizationId` is validated to reference a real, existing
 * organization — trusted directly rather than derived from
 * request.tenantId, since there is no auth yet to derive it from and
 * multiple organizations must be independently creatable. See this phase's
 * report for the exact scope of what this does and does not protect against
 * without authentication.
 */
export async function createMailbox(body: CreateMailboxBody): Promise<MailboxConnectionResponse> {
  const organization = await prisma.tenant.findUnique({ where: { id: body.organizationId } });
  if (!organization) throw new ValidationError(`Organization ${body.organizationId} not found`);

  try {
    const mailbox = await createMailboxConnection(body.organizationId, {
      name: body.name,
      emailAddress: body.email,
      host: body.host,
      port: body.port,
      tls: body.tls,
      folder: body.folder,
      username: body.username,
      password: body.password,
      ruleGraphId: body.ruleGraphId,
    });
    return serializeMailboxConnection(mailbox);
  } catch (error) {
    if (error instanceof MailboxValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/**
 * Tenant ownership is verified by updateMailboxConnection() itself (it looks
 * the row up scoped by tenantId, mirroring ruleService.ts's updateRule()
 * pattern) — this function's job is only to translate the API body and turn
 * a null result into the right HTTP error.
 */
export async function updateMailbox(tenantId: string, id: string, body: UpdateMailboxBody): Promise<MailboxConnectionResponse> {
  try {
    const updated = await updateMailboxConnection(tenantId, id, body);
    if (!updated) throw new NotFoundError(`Mailbox ${id} not found`);
    return serializeMailboxConnection(updated);
  } catch (error) {
    if (error instanceof MailboxValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/** Soft — see manageMailboxConnections.ts's deactivateMailboxConnection(). Replaces the Phase 6 "deleteMailboxUnsupported" 501. */
export async function deleteMailbox(tenantId: string, id: string): Promise<MailboxConnectionResponse> {
  const updated = await deactivateMailboxConnection(tenantId, id);
  if (!updated) throw new NotFoundError(`Mailbox ${id} not found`);
  return serializeMailboxConnection(updated);
}

export async function triggerMailboxReconciliation(tenantId: string, id: string): Promise<{ jobId: string }> {
  const row = await prisma.mailboxConnection.findFirst({ where: { id, tenantId } });
  if (!row) throw new NotFoundError(`Mailbox ${id} not found`);
  return enqueueMailboxReconciliation(id);
}
