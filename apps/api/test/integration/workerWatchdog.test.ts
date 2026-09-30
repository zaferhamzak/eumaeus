import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; html: string }> = [];
let failSends = false;
vi.mock("../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/email/mailer.js")>()),
  isMailerConfigured: async () => true,
  sendEmail: async (input: { to: string; subject: string; html: string }) => {
    if (failSends) throw new Error("smtp down");
    sent.push(input);
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { getRedisConnection } = await import("../../src/queue/connection.js");
const { WORKER_HEARTBEAT_KEY } = await import("../../src/runtime/workerHeartbeat.js");
const { announceWorkerNotice, checkWorker, WATCHDOG_DOWN_SINCE_KEY, WATCHDOG_LAST_SEEN_KEY, WATCHDOG_NOTIFIED_KEY } = await import("../../src/runtime/workerWatchdog.js");
const { loadEnv } = await import("../../src/config/env.js");
const { resetDatabase } = await import("../helpers/db.js");
const { createTestUser } = await import("../helpers/auth.js");

const MIN = 60_000;
const THRESHOLD = 5 * MIN;

/** 1.1 (A): the API notices a dead worker and tells the system administrators, once. */
describe("worker watchdog", () => {
  const redis = getRedisConnection();
  const beat = (at: Date) => redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: at.toISOString(), pid: 1 }), "EX", 60);

  // Tests must not depend on the developer's own .env (which may name real recipients).
  const env = loadEnv();
  const original = { emails: env.SYSTEM_ALERT_EMAILS, locale: env.SYSTEM_ALERT_LOCALE };
  afterAll(() => {
    env.SYSTEM_ALERT_EMAILS = original.emails;
    env.SYSTEM_ALERT_LOCALE = original.locale;
  });

  beforeEach(async () => {
    env.SYSTEM_ALERT_EMAILS = [];
    env.SYSTEM_ALERT_LOCALE = "en";
    await resetDatabase();
    await redis.del(WORKER_HEARTBEAT_KEY, WATCHDOG_DOWN_SINCE_KEY, WATCHDOG_NOTIFIED_KEY, WATCHDOG_LAST_SEEN_KEY);
    sent.length = 0;
    failSends = false;
  });

  it("says nothing while the worker beats, or before it has been missing for the threshold", async () => {
    const t0 = new Date("2026-09-29T01:00:00Z");
    await beat(t0);
    expect(await checkWorker(redis, t0, THRESHOLD)).toBeNull();

    await redis.del(WORKER_HEARTBEAT_KEY);
    expect(await checkWorker(redis, new Date(t0.getTime() + MIN), THRESHOLD)).toBeNull();
    expect(await checkWorker(redis, new Date(t0.getTime() + 5 * MIN), THRESHOLD)).toBeNull();
  });

  it("announces 'down' once after the threshold, then 'recovered' once when the heartbeat is back", async () => {
    const t0 = new Date("2026-09-29T01:00:00Z");
    await beat(t0);
    await checkWorker(redis, t0, THRESHOLD);
    await redis.del(WORKER_HEARTBEAT_KEY);

    expect(await checkWorker(redis, new Date(t0.getTime() + MIN), THRESHOLD)).toBeNull();
    const down = await checkWorker(redis, new Date(t0.getTime() + 7 * MIN), THRESHOLD);
    expect(down).toMatchObject({ kind: "down", lastSeenAt: t0, minutesDown: 7 });
    expect(await checkWorker(redis, new Date(t0.getTime() + 8 * MIN), THRESHOLD)).toBeNull();

    await beat(new Date(t0.getTime() + 20 * MIN));
    const back = await checkWorker(redis, new Date(t0.getTime() + 20 * MIN), THRESHOLD);
    expect(back).toMatchObject({ kind: "recovered", noticedAt: new Date(t0.getTime() + MIN) });
    expect(await checkWorker(redis, new Date(t0.getTime() + 21 * MIN), THRESHOLD)).toBeNull();
  });

  it("several API processes checking at once announce it only once", async () => {
    const t0 = new Date("2026-09-29T01:00:00Z");
    await checkWorker(redis, t0, THRESHOLD);
    const later = new Date(t0.getTime() + 6 * MIN);
    const results = await Promise.all([checkWorker(redis, later, THRESHOLD), checkWorker(redis, later, THRESHOLD), checkWorker(redis, later, THRESHOLD)]);
    expect(results.filter((r) => r?.kind === "down")).toHaveLength(1);
  });

  it("a worker that is back before the threshold is never announced", async () => {
    const t0 = new Date("2026-09-29T01:00:00Z");
    await checkWorker(redis, t0, THRESHOLD);
    await beat(new Date(t0.getTime() + 2 * MIN));
    expect(await checkWorker(redis, new Date(t0.getTime() + 2 * MIN), THRESHOLD)).toBeNull();
    await redis.del(WORKER_HEARTBEAT_KEY);
    // The clock starts again from the new disappearance.
    expect(await checkWorker(redis, new Date(t0.getTime() + 3 * MIN), THRESHOLD)).toBeNull();
    expect(await checkWorker(redis, new Date(t0.getTime() + 7 * MIN), THRESHOLD)).toBeNull();
    expect(await checkWorker(redis, new Date(t0.getTime() + 8 * MIN), THRESHOLD)).toMatchObject({ kind: "down" });
  });

  it("emails active system administrators only, each in their language", async () => {
    await createTestUser({ email: "root@ops.test", isSuperAdmin: true });
    const tr = await createTestUser({ email: "kok@ops.test", isSuperAdmin: true });
    await prisma.user.update({ where: { id: tr.id }, data: { locale: "tr" } });
    await createTestUser({ email: "gone@ops.test", isSuperAdmin: true, status: "disabled" });
    await createTestUser({ email: "member@ops.test" });

    const ok = await announceWorkerNotice({ kind: "down", noticedAt: new Date("2026-09-29T01:07:00Z"), lastSeenAt: new Date("2026-09-29T01:06:00Z"), minutesDown: 6 });
    expect(ok).toBe(true);
    expect(sent.map((m) => m.to).sort()).toEqual(["kok@ops.test", "root@ops.test"]);
    expect(sent.find((m) => m.to === "root@ops.test")!.subject).toBe("Eumaeus: the background worker has stopped");
    expect(sent.find((m) => m.to === "kok@ops.test")!.subject).toBe("Eumaeus: arka plan worker'ı durdu");
    expect(sent[0]!.html).toContain("/system");
  });

  it("SYSTEM_ALERT_EMAILS replaces the administrators' (possibly placeholder) addresses", async () => {
    await createTestUser({ email: "admin@placeholder.local", isSuperAdmin: true });
    const known = await createTestUser({ email: "ops@real.test" });
    await prisma.user.update({ where: { id: known.id }, data: { locale: "tr" } });
    env.SYSTEM_ALERT_EMAILS = ["ops@real.test", "oncall@real.test"];
    await announceWorkerNotice({ kind: "recovered", noticedAt: new Date("2026-09-29T01:07:00Z"), recoveredAt: new Date("2026-09-29T15:26:00Z") });
    expect(sent.map((m) => m.to).sort()).toEqual(["oncall@real.test", "ops@real.test"]);
    // An address with an account gets its language; the rest get SYSTEM_ALERT_LOCALE.
    expect(sent.find((m) => m.to === "ops@real.test")!.subject).toBe("Eumaeus: arka plan worker'ı yeniden çalışıyor");
    expect(sent.find((m) => m.to === "oncall@real.test")!.subject).toBe("Eumaeus: the background worker is running again");
    expect(sent[0]!.html).toContain("14");
  });

  it("reports failure when no email could be sent, so the watchdog can try again", async () => {
    await createTestUser({ email: "root@ops.test", isSuperAdmin: true });
    failSends = true;
    expect(await announceWorkerNotice({ kind: "down", noticedAt: new Date(), lastSeenAt: null, minutesDown: 5 })).toBe(false);
  });
});
