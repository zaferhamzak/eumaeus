import { prisma } from "../../db/client.js";
import { getSystemSettings } from "../../modules/settings/systemSettings.js";
import { createInvite } from "../../modules/auth/authService.js";
import { isMailerConfigured, sendEmail } from "../../modules/email/mailer.js";
import { buildInviteEmail } from "../../modules/email/inviteEmail.js";
import { logger } from "../../logger.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { serializeMembership, type MembershipResponse } from "../serializers/memberSerializer.js";
import type { InviteMemberBody, UpdateMemberBody } from "../schemas/members.js";
import { toLocale } from "../../modules/i18n/locales.js";

export async function listMembers(tenantId: string): Promise<{ data: MembershipResponse[] }> {
  const rows = await prisma.membership.findMany({
    where: { tenantId },
    include: { user: { select: { email: true } } },
    orderBy: { invitedAt: "asc" },
  });
  return { data: rows.map(serializeMembership) };
}

/**
 * Returns the raw invite token AND the full accept-invite link ALONGSIDE the
 * serialized membership — the ONE response where the token appears, never
 * persisted, never returned again by any other endpoint. This is
 * intentionally not just a courtesy: sending the invite email is
 * best-effort (isMailerConfigured() may be false, or the send may fail for
 * a reason that has nothing to do with whether the invite itself is valid —
 * a typo'd relay host, a provider outage), so the caller ALWAYS gets the
 * link back and can share it manually regardless of `emailSent`.
 */
export async function inviteMember(
  tenantId: string,
  body: InviteMemberBody,
): Promise<{ membership: MembershipResponse; inviteToken: string; acceptUrl: string; emailSent: boolean }> {
  const { rawToken, membershipId } = await createInvite(tenantId, body.email, body.permissions);
  const [row, tenant] = await Promise.all([
    prisma.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { user: { select: { email: true, locale: true } } } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  ]);

  const settings = await getSystemSettings();
  const acceptUrl = `${settings.appBaseUrl}/accept-invite?token=${encodeURIComponent(rawToken)}`;

  let emailSent = false;
  if (await isMailerConfigured()) {
    try {
      // Phase 21: an existing account's language, otherwise the organization's.
      const email = buildInviteEmail(tenant.name, acceptUrl, toLocale(row.user.locale, toLocale(tenant.locale)));
      await sendEmail({ to: body.email, ...email, meta: { kind: "invite", tenantId: tenant.id, relatedId: membershipId } });
      emailSent = true;
    } catch (error) {
      // Best-effort: the invite (and the link returned below) is already
      // real and valid regardless of whether the email itself went out —
      // never fail the whole request over an SMTP hiccup.
      logger.warn({ event: "invite_email_send_failed", membershipId, err: error }, "failed to send invite email");
    }
  }

  return { membership: serializeMembership(row), inviteToken: rawToken, acceptUrl, emailSent };
}

async function requireMembershipInTenant(tenantId: string, membershipId: string) {
  const row = await prisma.membership.findFirst({ where: { id: membershipId, tenantId }, include: { user: { select: { email: true } } } });
  if (!row) throw new NotFoundError(`Membership ${membershipId} not found in this organization`);
  return row;
}

export async function updateMember(tenantId: string, membershipId: string, body: UpdateMemberBody): Promise<MembershipResponse> {
  await requireMembershipInTenant(tenantId, membershipId);
  if (body.permissions === undefined && body.status === undefined) {
    throw new ValidationError("At least one of permissions or status must be provided");
  }
  const updated = await prisma.membership.update({
    where: { id: membershipId },
    data: { ...(body.permissions !== undefined ? { permissions: body.permissions } : {}), ...(body.status !== undefined ? { status: body.status } : {}) },
    include: { user: { select: { email: true } } },
  });
  return serializeMembership(updated);
}

/** Soft — same convention as every other resource: status flips to "revoked", the row (and its history) is never deleted. */
export async function revokeMember(tenantId: string, membershipId: string): Promise<void> {
  await requireMembershipInTenant(tenantId, membershipId);
  await prisma.membership.update({ where: { id: membershipId }, data: { status: "revoked" } });
}
