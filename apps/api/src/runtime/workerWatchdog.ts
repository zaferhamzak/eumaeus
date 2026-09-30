import type { Redis } from "ioredis";
import { prisma } from "../db/client.js";
import { logger } from "../logger.js";
import { isMailerConfigured, sendEmail } from "../modules/email/mailer.js";
import { buildWorkerAlertEmail, type WorkerNotice } from "../modules/email/workerAlertEmail.js";
import { toLocale, type Locale } from "../modules/i18n/locales.js";
import { loadEnv } from "../config/env.js";
import { getSystemSettings } from "../modules/settings/systemSettings.js";
import { readWorkerStatus } from "./workerHeartbeat.js";

/**
 * 1.1 (A): the API watches the worker. Every job — mail sync, analysis,
 * actions, and the operational alerts themselves — runs in the worker, so
 * when it dies nothing in it can say so (on 2026-09-29 that meant 14 silent
 * hours). The API reads the worker's heartbeat each minute; once it has been
 * missing for the threshold, the system administrators get one email, and
 * one more when it is back.
 *
 * The state lives in Redis so that several API processes send each email
 * once: the first to see the worker missing stamps DOWN_SINCE, the first to
 * cross the threshold claims NOTIFIED (SET NX), and the first to see it back
 * takes NOTIFIED (GETDEL) and sends the "recovered" email.
 */
export const WATCHDOG_DOWN_SINCE_KEY = "eumaeus:watchdog:worker-down-since";
export const WATCHDOG_NOTIFIED_KEY = "eumaeus:watchdog:worker-down-notified";
export const WATCHDOG_LAST_SEEN_KEY = "eumaeus:watchdog:worker-last-seen";

/** One watchdog tick: what, if anything, should be announced now. */
export async function checkWorker(redis: Redis, now: Date, thresholdMs: number): Promise<WorkerNotice | null> {
  const status = await readWorkerStatus(redis);
  if (status.status === "ok") {
    if (status.lastSeenAt) await redis.set(WATCHDOG_LAST_SEEN_KEY, status.lastSeenAt);
    await redis.del(WATCHDOG_DOWN_SINCE_KEY);
    const notified = await redis.getdel(WATCHDOG_NOTIFIED_KEY);
    return notified ? { kind: "recovered", noticedAt: new Date(notified), recoveredAt: now } : null;
  }

  await redis.set(WATCHDOG_DOWN_SINCE_KEY, now.toISOString(), "NX");
  const since = new Date((await redis.get(WATCHDOG_DOWN_SINCE_KEY)) ?? now.toISOString());
  if (now.getTime() - since.getTime() < thresholdMs) return null;
  if ((await redis.set(WATCHDOG_NOTIFIED_KEY, since.toISOString(), "NX")) !== "OK") return null;
  const lastSeen = await redis.get(WATCHDOG_LAST_SEEN_KEY);
  const lastSeenAt = lastSeen ? new Date(lastSeen) : null;
  const from = lastSeenAt ?? since;
  return { kind: "down", noticedAt: since, lastSeenAt, minutesDown: Math.max(1, Math.round((now.getTime() - from.getTime()) / 60_000)) };
}

/**
 * Who hears about it: SYSTEM_ALERT_EMAILS if set (in the language of the
 * matching account, else SYSTEM_ALERT_LOCALE), otherwise every active system
 * administrator — whose account address may well be a placeholder, hence the
 * setting.
 */
async function recipients(): Promise<Array<{ email: string; locale: Locale }>> {
  const env = loadEnv();
  if (env.SYSTEM_ALERT_EMAILS.length > 0) {
    const users = await prisma.user.findMany({ where: { email: { in: env.SYSTEM_ALERT_EMAILS } }, select: { email: true, locale: true } });
    const byEmail = new Map(users.map((u) => [u.email, u.locale]));
    return env.SYSTEM_ALERT_EMAILS.map((email) => ({ email, locale: toLocale(byEmail.get(email), env.SYSTEM_ALERT_LOCALE) }));
  }
  const admins = await prisma.user.findMany({ where: { isSuperAdmin: true, status: "active" }, select: { email: true, locale: true } });
  return admins.map((a) => ({ email: a.email, locale: toLocale(a.locale, env.SYSTEM_ALERT_LOCALE) }));
}

/** Emails the system recipients (see recipients()). True if at least one email went out. */
export async function announceWorkerNotice(notice: WorkerNotice): Promise<boolean> {
  logger[notice.kind === "down" ? "error" : "info"]({ event: notice.kind === "down" ? "worker_down" : "worker_recovered", notice }, notice.kind === "down" ? "the worker has stopped sending heartbeats" : "the worker is back");
  if (!(await isMailerConfigured())) {
    logger.warn({ event: "worker_notice_no_smtp" }, "SMTP is not configured — nobody was emailed about the worker");
    return false;
  }
  const [targets, settings] = await Promise.all([recipients(), getSystemSettings()]);
  let sent = false;
  for (const target of targets) {
    try {
      await sendEmail({ to: target.email, ...buildWorkerAlertEmail(notice, settings.appBaseUrl, target.locale), meta: { kind: "worker" } });
      sent = true;
    } catch (error) {
      logger.warn({ event: "worker_notice_email_failed", err: error }, "could not send a worker status email");
    }
  }
  return sent;
}

/** Runs the watchdog every `intervalMs`; returns a stop function. */
export function startWorkerWatchdog(redis: Redis, options: { thresholdMs: number; intervalMs?: number }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const notice = await checkWorker(redis, new Date(), options.thresholdMs);
      if (!notice) return;
      const sent = await announceWorkerNotice(notice);
      // Nobody got the "down" email (SMTP failing): give the claim back so the next tick tries again.
      if (!sent && notice.kind === "down" && (await isMailerConfigured())) await redis.del(WATCHDOG_NOTIFIED_KEY);
    } catch (error) {
      logger.warn({ event: "worker_watchdog_failed", err: error }, "worker watchdog check failed");
    } finally {
      running = false;
    }
  };
  // A first look right away, so a worker that stops soon after the API starts still has a "last heartbeat".
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
