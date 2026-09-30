import type { Alert, Tenant } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { isMailerConfigured, sendEmail } from "../email/mailer.js";
import { buildAlertEmail } from "../email/alertEmail.js";
import { formatEmailTime } from "../email/emailLayout.js";
import { localizedAlertText } from "./alertText.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { decryptSecret } from "../secrets/secretCrypto.js";
import { assertSsrfSafeUrl } from "../destinations/executors/ssrf.js";
import { performWebhookRequest } from "../destinations/executors/webhookHttpClient.js";
import { logger } from "../../logger.js";
import { currentConditions, type AlertCondition } from "./conditions.js";
import { toLocale } from "../i18n/locales.js";

/**
 * Turns current conditions into alerts (Phase 18), every few minutes:
 *   condition true, no open alert   -> open one, notify, audit
 *   condition true, alert open      -> refresh it; notify again once a day while it lasts
 *   alert open, condition cleared   -> resolve it, notify, audit
 *
 * A person can dismiss an open alert (dismissAlert). A dismissed alert stays
 * quiet while its condition lasts — no reopening, no reminders — and is
 * resolved silently when the condition clears; if the problem comes back
 * after that, a new alert opens as usual.
 *
 * Notifications go by email to the organization's members with
 * organizations:write (if alert emails are on and SMTP works), and to the
 * organization's alert webhook if one is set. A failed notification is
 * logged and never stops evaluation.
 */
export const RENOTIFY_AFTER_MS = 24 * 60 * 60 * 1000;

export async function evaluateAlerts(now: Date = new Date()): Promise<{ opened: number; resolved: number }> {
  const tenants = await prisma.tenant.findMany({ where: { status: "active" } });
  let opened = 0;
  let resolved = 0;
  for (const tenant of tenants) {
    try {
      const r = await evaluateTenant(tenant, now);
      opened += r.opened;
      resolved += r.resolved;
    } catch (error) {
      logger.error({ event: "alert_evaluation_failed", err: error, tenantId: tenant.id }, "alert evaluation failed for an organization");
    }
  }
  return { opened, resolved };
}

export async function evaluateTenant(tenant: Tenant, now: Date): Promise<{ opened: number; resolved: number }> {
  const conditions = await currentConditions(tenant.id, now);
  const open = await prisma.alert.findMany({ where: { tenantId: tenant.id, status: { in: ["open", "dismissed"] } } });
  const key = (a: { kind: string; subjectKey: string }) => `${a.kind}|${a.subjectKey}`;
  const openByKey = new Map(open.map((a) => [key(a), a]));
  let opened = 0;
  let resolved = 0;

  for (const condition of conditions) {
    const existing = openByKey.get(key(condition));
    openByKey.delete(key(condition));
    if (!existing) {
      const alert = await prisma.alert.create({ data: { tenantId: tenant.id, kind: condition.kind, subjectKey: condition.subjectKey, title: condition.title, detail: condition.detail, params: condition.params, firstSeenAt: now, lastSeenAt: now } });
      await recordAuditEvent(prisma, { tenantId: tenant.id, eventType: AuditEventType.ALERT_OPENED, actor: "system", payload: { alertId: alert.id, kind: alert.kind, title: alert.title } });
      await notify(tenant, alert, false, now);
      opened += 1;
      continue;
    }
    const updated = await prisma.alert.update({ where: { id: existing.id }, data: { lastSeenAt: now, title: condition.title, detail: condition.detail, params: condition.params } });
    if (existing.status === "dismissed") continue;
    if (!existing.lastNotifiedAt || now.getTime() - existing.lastNotifiedAt.getTime() >= RENOTIFY_AFTER_MS) await notify(tenant, updated, false, now, Boolean(existing.lastNotifiedAt));
  }

  for (const stale of openByKey.values()) {
    const alert = await prisma.alert.update({ where: { id: stale.id }, data: { status: "resolved", resolvedAt: now } });
    await recordAuditEvent(prisma, { tenantId: tenant.id, eventType: AuditEventType.ALERT_RESOLVED, actor: "system", payload: { alertId: alert.id, kind: alert.kind, title: alert.title, wasDismissed: stale.status === "dismissed" } });
    // Someone already closed it by hand: no "resolved" message for an alert they chose to silence.
    if (stale.status !== "dismissed") await notify(tenant, alert, true, now);
    resolved += 1;
  }
  return { opened, resolved };
}

async function notify(tenant: Tenant, alert: Alert, resolved: boolean, now: Date, reminder = false): Promise<void> {
  const settings = await getSystemSettings();
  const link = `${settings.appBaseUrl.replace(/\/$/, "")}/`;
  let notified = false;

  if (tenant.alertEmailsEnabled && (await isMailerConfigured())) {
    const recipients = await prisma.membership.findMany({
      where: { tenantId: tenant.id, status: "active", permissions: { has: "organizations:write" }, user: { status: "active" } },
      select: { user: { select: { email: true, locale: true } } },
    });
    const timeZone = businessHoursTimeZone(tenant.businessHours);
    for (const { user } of recipients) {
      const locale = toLocale(user.locale, toLocale(tenant.locale));
      // 1.2 (E): in the reader's language; alerts from before 1.2 keep their stored text.
      const text = localizedAlertText(alert, locale, (iso) => formatEmailTime(new Date(iso), locale, timeZone ?? "UTC")) ?? { title: alert.title, detail: alert.detail };
      const message = buildAlertEmail({
        organizationName: tenant.name,
        title: text.title,
        detail: text.detail,
        resolved,
        link,
        locale,
        kind: alert.kind,
        reminder,
        firstSeenAt: alert.firstSeenAt,
        resolvedAt: alert.resolvedAt,
        timeZone,
        settingsLink: `${link}organizations/${tenant.id}`,
      });
      try {
        await sendEmail({ to: user.email, ...message, meta: { kind: "alert", tenantId: tenant.id, relatedId: alert.id } });
        notified = true;
      } catch (error) {
        logger.warn({ event: "alert_email_failed", err: error, alertId: alert.id }, "could not send an alert email");
      }
    }
  }

  if (tenant.alertWebhookUrlEncrypted) {
    try {
      const url = decryptSecret(tenant.alertWebhookUrlEncrypted);
      const target = await assertSsrfSafeUrl(url);
      const body = JSON.stringify({
        event: resolved ? "alert.resolved" : "alert.opened",
        organization: { id: tenant.id, name: tenant.name },
        alert: { id: alert.id, kind: alert.kind, title: alert.title, detail: alert.detail, firstSeenAt: alert.firstSeenAt.toISOString(), resolvedAt: alert.resolvedAt?.toISOString() ?? null },
      });
      await performWebhookRequest({ url, address: target.address, family: target.family, headers: { "content-type": "application/json" }, body, timeoutMs: 10_000 });
      notified = true;
    } catch (error) {
      logger.warn({ event: "alert_webhook_failed", err: error, alertId: alert.id }, "could not deliver an alert webhook");
    }
  }

  if (notified) await prisma.alert.update({ where: { id: alert.id }, data: { lastNotifiedAt: now } });
}

export class AlertNotOpenError extends Error {}

/** A person closes an open alert. It stays closed while the problem lasts (see evaluateTenant). */
export async function dismissAlert(tenantId: string, alertId: string, actor: string, now: Date = new Date()): Promise<Alert | null> {
  const alert = await prisma.alert.findFirst({ where: { id: alertId, tenantId } });
  if (!alert) return null;
  if (alert.status !== "open") throw new AlertNotOpenError(alert.status === "dismissed" ? "This alert was already closed." : "This alert is already resolved.");
  const updated = await prisma.alert.update({ where: { id: alertId }, data: { status: "dismissed", dismissedAt: now, dismissedBy: actor } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.ALERT_DISMISSED, actor, payload: { alertId, kind: alert.kind, title: alert.title } });
  return updated;
}

export type { AlertCondition };

/** The organization's own time zone, if it has set business hours; alert emails show times in it. */
function businessHoursTimeZone(businessHours: unknown): string | undefined {
  const zone = (businessHours as { timeZone?: unknown } | null)?.timeZone;
  return typeof zone === "string" && zone ? zone : undefined;
}
