import type { Redis } from "ioredis";
import { prisma } from "../db/client.js";
import { logger } from "../logger.js";
import type { Env } from "../config/env.js";
import { createImapFlowIdleConnection, IDLE_STATE_KEY, IdleManager, publishIdleStates, type IdleConnectionFactory, type IdleMailbox } from "../modules/mail-providers/imap/idle.js";
import { resolveMailboxSecret } from "../modules/mail-providers/imap/mailboxAuth.js";
import { applyPollInterval, enqueueIdleSync } from "../queue/mailboxSyncQueue.js";
import { getSystemSettings } from "../modules/settings/systemSettings.js";

/** Active mailboxes of active organizations, as the IDLE manager needs them. */
export async function loadIdleMailboxes(): Promise<IdleMailbox[]> {
  const rows = await prisma.mailboxConnection.findMany({
    where: { status: "active", tenant: { status: "active" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, tenantId: true, authType: true, emailAddress: true, providerConfig: true },
  });
  return rows.flatMap((r) => {
    const c = r.providerConfig as Partial<IdleMailbox["config"]> | null;
    if (!c?.host || !c.port || !c.username) return [];
    return [{ id: r.id, tenantId: r.tenantId, authType: r.authType, emailAddress: r.emailAddress, config: { host: c.host, port: c.port, tls: c.tls !== false, username: c.username, folder: c.folder || "INBOX" } }];
  });
}

/**
 * 1.1 (C): starts IDLE for the worker — the manager, a reconcile every
 * minute (mailboxes added, removed, disabled or changed), and the published
 * states the API shows. Returns a stop function for the shutdown sequence.
 */
export function startIdleRunner(redis: Redis, env: Env, factory: IdleConnectionFactory = createImapFlowIdleConnection): { manager: IdleManager; stop: () => Promise<void> } {
  const pollIntervals = async () => {
    const settings = await getSystemSettings();
    return { normalMs: settings.mailboxSyncIntervalSeconds * 1000, fallbackMs: env.MAIL_POLL_FALLBACK_SECONDS * 1000 };
  };
  const manager = new IdleManager({
    factory,
    resolveSecret: (m) => resolveMailboxSecret(m),
    loadMailboxes: loadIdleMailboxes,
    onNewMail: (id) => enqueueIdleSync(id),
    onLiveChange: async (id, live) => {
      const { normalMs, fallbackMs } = await pollIntervals();
      await applyPollInterval(id, live, normalMs, fallbackMs);
      await publishIdleStates(redis, manager.states()).catch(() => {});
    },
    maxConnections: env.MAIL_IDLE_MAX_CONNECTIONS,
    log: logger,
  });

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await manager.reconcile();
      // Settings or another process may have reset a schedule; keep live mailboxes on the slow poll.
      const { normalMs, fallbackMs } = await pollIntervals();
      for (const [id, s] of manager.states()) if (s.state === "live") await applyPollInterval(id, true, normalMs, fallbackMs);
      await publishIdleStates(redis, manager.states());
    } catch (error) {
      logger.warn({ event: "idle_reconcile_failed", err: error }, "IDLE reconcile failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();

  return {
    manager,
    stop: async () => {
      clearInterval(timer);
      await manager.stop();
      await redis.del(IDLE_STATE_KEY).catch(() => {});
    },
  };
}
