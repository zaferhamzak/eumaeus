import type { ForwardRecipient } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { generateInviteToken, hashInviteToken } from "../auth/inviteToken.js";
import { isMailerConfigured, sendEmail } from "../email/mailer.js";
import { buildForwardVerificationEmail } from "../email/forwardVerificationEmail.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { logger } from "../../logger.js";
import { toLocale } from "../i18n/locales.js";

/**
 * Opt-in for forward recipients (Phase 13.3). Saving a forward channel
 * registers each of its addresses here; a new address gets a confirmation
 * link by email, and the forward executor only ever sends to "verified"
 * rows. The raw token lives only in that email — like invites, just its
 * SHA-256 is stored.
 */
export const FORWARD_VERIFICATION_TTL_DAYS = 7;

export interface RecipientRequestResult {
  address: string;
  status: string;
  /** A confirmation email went out on this call. */
  emailSent: boolean;
}

/**
 * Ensures a ForwardRecipient row exists for each address and that every
 * unconfirmed one has a live confirmation link on its way. Verified
 * addresses are left alone; revoked ones start over as pending (saving a
 * channel with that address again is an explicit request to use it).
 */
export async function requestForwardRecipients(tenantId: string, addresses: string[], actor: string | undefined): Promise<RecipientRequestResult[]> {
  const results: RecipientRequestResult[] = [];
  for (const raw of new Set(addresses.map((a) => a.trim().toLowerCase()))) {
    const existing = await prisma.forwardRecipient.findUnique({ where: { tenantId_address: { tenantId, address: raw } } });
    if (existing?.status === "verified") {
      results.push({ address: raw, status: "verified", emailSent: false });
      continue;
    }
    const linkStillValid = existing?.status === "pending" && existing.tokenExpiresAt !== null && existing.tokenExpiresAt > new Date();
    if (linkStillValid) {
      results.push({ address: raw, status: "pending", emailSent: false });
      continue;
    }
    const recipient = await issueConfirmation(tenantId, raw, existing, actor);
    results.push({ address: raw, status: recipient.status, emailSent: recipient.emailSent });
  }
  return results;
}

/** A fresh link for a pending (or revoked) recipient. */
export async function resendForwardVerification(tenantId: string, recipientId: string, actor: string | undefined): Promise<{ recipient: ForwardRecipient; emailSent: boolean } | null> {
  const existing = await prisma.forwardRecipient.findFirst({ where: { id: recipientId, tenantId } });
  if (!existing) return null;
  if (existing.status === "verified") return { recipient: existing, emailSent: false };
  const { emailSent } = await issueConfirmation(tenantId, existing.address, existing, actor);
  return { recipient: await prisma.forwardRecipient.findUniqueOrThrow({ where: { id: recipientId } }), emailSent };
}

async function issueConfirmation(
  tenantId: string,
  address: string,
  existing: ForwardRecipient | null,
  actor: string | undefined,
): Promise<{ status: string; emailSent: boolean }> {
  const token = generateInviteToken();
  const tokenExpiresAt = new Date(Date.now() + FORWARD_VERIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const data = { status: "pending", tokenHash: hashInviteToken(token), tokenExpiresAt, requestedBy: actor ?? null, verifiedAt: null };
  const recipient = existing
    ? await prisma.forwardRecipient.update({ where: { id: existing.id }, data })
    : await prisma.forwardRecipient.create({ data: { tenantId, address, ...data } });

  let emailSent = false;
  if (await isMailerConfigured()) {
    const [settings, tenant] = await Promise.all([getSystemSettings(), prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, locale: true } })]);
    const confirmUrl = `${settings.appBaseUrl.replace(/\/$/, "")}/verify-forward?token=${encodeURIComponent(token)}`;
    try {
      await sendEmail({ to: address, ...buildForwardVerificationEmail(tenant.name, confirmUrl, FORWARD_VERIFICATION_TTL_DAYS, toLocale(tenant.locale)), meta: { kind: "forward_verification", tenantId, relatedId: recipient.id } });
      emailSent = true;
    } catch (error) {
      // Saving the channel must not fail because the confirmation couldn't be
      // sent right now — the recipient stays pending and can be re-sent from
      // the Forwarding tab.
      logger.warn({ event: "forward_verification_send_failed", err: error, recipientId: recipient.id }, "could not send forward confirmation email");
    }
  }

  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.FORWARD_RECIPIENT_REQUESTED,
    actor: actor ?? "system",
    payload: { recipientId: recipient.id, address, emailSent },
  });
  return { status: recipient.status, emailSent };
}

export type VerifyResult = { ok: true; address: string; organizationName: string } | { ok: false; reason: "invalid" | "expired" };

/** Public: called from the link in the confirmation email. The token is the only credential. */
export async function verifyForwardRecipient(token: string): Promise<VerifyResult> {
  const recipient = await prisma.forwardRecipient.findFirst({ where: { tokenHash: hashInviteToken(token), status: "pending" }, include: { tenant: { select: { name: true } } } });
  if (!recipient) return { ok: false, reason: "invalid" };
  if (!recipient.tokenExpiresAt || recipient.tokenExpiresAt < new Date()) return { ok: false, reason: "expired" };

  await prisma.forwardRecipient.update({ where: { id: recipient.id }, data: { status: "verified", verifiedAt: new Date(), tokenHash: null, tokenExpiresAt: null } });
  await recordAuditEvent(prisma, {
    tenantId: recipient.tenantId,
    eventType: AuditEventType.FORWARD_RECIPIENT_VERIFIED,
    actor: recipient.address,
    payload: { recipientId: recipient.id, address: recipient.address },
  });
  return { ok: true, address: recipient.address, organizationName: recipient.tenant.name };
}

/** Stops all forwarding to the address immediately (the executor skips non-verified recipients). */
export async function revokeForwardRecipient(tenantId: string, recipientId: string, actor: string | undefined): Promise<ForwardRecipient | null> {
  const existing = await prisma.forwardRecipient.findFirst({ where: { id: recipientId, tenantId } });
  if (!existing) return null;
  const updated = await prisma.forwardRecipient.update({ where: { id: existing.id }, data: { status: "revoked", tokenHash: null, tokenExpiresAt: null } });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.FORWARD_RECIPIENT_REVOKED,
    actor: actor ?? "system",
    payload: { recipientId: existing.id, address: existing.address },
  });
  return updated;
}

export async function listForwardRecipients(tenantId: string): Promise<ForwardRecipient[]> {
  return prisma.forwardRecipient.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { address: "asc" }] });
}
