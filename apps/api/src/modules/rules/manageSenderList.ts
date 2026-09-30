import type { SenderListEntry } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { normalizeSenderPattern, type SenderListKind } from "./senderLists.js";

export class SenderListError extends Error {}

export async function listSenderEntries(tenantId: string): Promise<SenderListEntry[]> {
  return prisma.senderListEntry.findMany({ where: { tenantId }, orderBy: [{ kind: "asc" }, { pattern: "asc" }] });
}

/** Adds an allow / block entry. A pattern can be on the list only once — to switch it from allow to block, remove it first. */
export async function addSenderEntry(
  tenantId: string,
  input: { kind: SenderListKind; pattern: string; note?: string; source?: "manual" | "suggestion" },
  actor: string | undefined,
): Promise<SenderListEntry> {
  const pattern = normalizeSenderPattern(input.pattern);
  if (!pattern) throw new SenderListError(`"${input.pattern}" is not an email address or a domain (write a domain as example.com or @example.com)`);
  const note = input.note?.trim() || null;
  if (note && note.length > 200) throw new SenderListError("the note can be at most 200 characters");

  const existing = await prisma.senderListEntry.findUnique({ where: { tenantId_pattern: { tenantId, pattern } } });
  if (existing) throw new SenderListError(`"${pattern}" is already on the ${existing.kind === "allow" ? "allow" : "block"} list`);

  const entry = await prisma.senderListEntry.create({ data: { tenantId, kind: input.kind, pattern, note, source: input.source ?? "manual", createdBy: actor ?? null } });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.SENDER_LIST_ENTRY_ADDED,
    actor: actor ?? "system",
    payload: { entryId: entry.id, kind: entry.kind, pattern, source: entry.source },
  });
  return entry;
}

export async function removeSenderEntry(tenantId: string, id: string, actor: string | undefined): Promise<boolean> {
  const entry = await prisma.senderListEntry.findFirst({ where: { id, tenantId } });
  if (!entry) return false;
  await prisma.senderListEntry.delete({ where: { id } });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.SENDER_LIST_ENTRY_REMOVED,
    actor: actor ?? "system",
    payload: { entryId: id, kind: entry.kind, pattern: entry.pattern },
  });
  return true;
}
