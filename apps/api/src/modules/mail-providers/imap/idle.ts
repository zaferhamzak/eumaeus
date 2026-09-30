import { ImapFlow } from "imapflow";
import type { Redis } from "ioredis";
import { imapAuth, type ImapSecret } from "./mailboxAuth.js";

/**
 * 1.1 (C): new mail within seconds instead of at the next poll.
 *
 * The worker keeps one IMAP connection per active mailbox, parked on the
 * mailbox's folder; imapflow issues IDLE on it and emits `exists` when the
 * server reports a new message. That only *triggers* the ordinary sync job —
 * fetching, storing and the cursor stay in sync.ts, so there is still exactly
 * one way mail comes in. Polling stays as the safety net: slowed down while
 * a mailbox's connection is live, back to normal the moment it drops.
 *
 * A dropped connection (sleep, network, server restart) is reopened with a
 * growing delay; a rejected sign-in waits the longest delay, and the polling
 * sync — which owns "sign-in rejected" handling — decides whether the mailbox
 * needs a new password.
 */

export interface IdleMailbox {
  id: string;
  tenantId: string;
  authType: string;
  emailAddress: string;
  config: { host: string; port: number; tls: boolean; username: string; folder: string };
}

/** The narrow seam the manager needs from an IMAP connection (a fake in tests). */
export interface IdleConnection {
  connect(): Promise<void>;
  /** Selects the folder and leaves it selected, so the library idles on it. */
  watch(folder: string): Promise<void>;
  onNewMail(listener: () => void): void;
  /** Fires once when the connection is gone, whatever the reason. */
  onClose(listener: (error?: unknown) => void): void;
  close(): Promise<void>;
}

export type IdleConnectionFactory = (mailbox: IdleMailbox, secret: ImapSecret) => IdleConnection;

export type IdleState = "connecting" | "live" | "waiting";

export interface IdleManagerDeps {
  factory: IdleConnectionFactory;
  resolveSecret: (mailbox: IdleMailbox) => Promise<ImapSecret>;
  /** Active mailboxes of active organizations. */
  loadMailboxes: () => Promise<IdleMailbox[]>;
  /** New mail reported (or a connection came back): run the mailbox's sync. */
  onNewMail: (mailboxId: string) => Promise<void>;
  /** A mailbox's connection became live (true) or stopped being live (false). */
  onLiveChange: (mailboxId: string, live: boolean) => Promise<void>;
  maxConnections: number;
  /** Delays before reconnecting, by attempt; the last one repeats. */
  backoffMs?: number[];
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

function fingerprint(m: IdleMailbox): string {
  const c = m.config;
  return [m.authType, c.host, c.port, c.tls, c.username, c.folder].join("|");
}

function isAuthFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { authenticationFailed?: unknown }).authenticationFailed);
}

class Watcher {
  state: IdleState = "connecting";
  since = new Date();
  private conn: IdleConnection | undefined;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private wasLive = false;

  constructor(
    readonly mailbox: IdleMailbox,
    readonly key: string,
    private readonly deps: IdleManagerDeps,
  ) {}

  start(): void {
    void this.open();
  }

  private setState(state: IdleState): void {
    if (this.state !== state) {
      this.state = state;
      this.since = new Date();
    }
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.setState("connecting");
    let conn: IdleConnection | undefined;
    try {
      const secret = await this.deps.resolveSecret(this.mailbox);
      if (this.stopped) return;
      conn = this.deps.factory(this.mailbox, secret);
      this.conn = conn;
      let closed = false;
      conn.onClose((error) => {
        if (closed) return;
        closed = true;
        if (this.conn === conn) void this.dropped(error);
      });
      conn.onNewMail(() => {
        if (!this.stopped) void this.deps.onNewMail(this.mailbox.id).catch((error) => this.deps.log?.warn({ event: "idle_enqueue_failed", mailboxConnectionId: this.mailbox.id, err: error }, "could not queue a sync for new mail"));
      });
      await conn.connect();
      await conn.watch(this.mailbox.config.folder);
      if (this.stopped || this.conn !== conn) return;
      const reconnected = this.attempt > 0;
      this.attempt = 0;
      this.setState("live");
      this.wasLive = true;
      await this.deps.onLiveChange(this.mailbox.id, true);
      // Mail may have arrived while the connection was away.
      if (reconnected) await this.deps.onNewMail(this.mailbox.id);
      this.deps.log?.info({ event: "idle_live", mailboxConnectionId: this.mailbox.id }, `live (IDLE) for ${this.mailbox.emailAddress}`);
    } catch (error) {
      if (this.conn === conn) await this.dropped(error);
    }
  }

  private async dropped(error?: unknown): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    if (conn) await conn.close().catch(() => {});
    if (this.stopped) return;
    if (this.wasLive) {
      this.wasLive = false;
      await this.deps.onLiveChange(this.mailbox.id, false).catch(() => {});
    }
    const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = isAuthFailure(error) ? backoff[backoff.length - 1]! : backoff[Math.min(this.attempt, backoff.length - 1)]!;
    this.attempt += 1;
    this.setState("waiting");
    this.deps.log?.warn(
      { event: "idle_dropped", mailboxConnectionId: this.mailbox.id, retryInMs: delay, err: error instanceof Error ? { message: error.message, code: (error as { code?: unknown }).code } : undefined },
      `IDLE connection for ${this.mailbox.emailAddress} dropped; retrying in ${Math.round(delay / 1000)} s`,
    );
    this.timer = setTimeout(() => void this.open(), delay);
    this.timer.unref();
  }

  /** Closes the connection for good. Does not touch polling — the caller knows why it stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const conn = this.conn;
    this.conn = undefined;
    if (conn) await conn.close().catch(() => {});
  }
}

export class IdleManager {
  private readonly watchers = new Map<string, Watcher>();

  constructor(private readonly deps: IdleManagerDeps) {}

  /** Brings the set of open connections in line with the active mailboxes. Safe to call repeatedly. */
  async reconcile(): Promise<void> {
    const mailboxes = await this.deps.loadMailboxes();
    const wanted = new Map(mailboxes.map((m) => [m.id, m]));

    for (const [id, watcher] of this.watchers) {
      const m = wanted.get(id);
      if (!m || fingerprint(m) !== watcher.key) {
        this.watchers.delete(id);
        await watcher.stop();
      }
    }
    for (const m of mailboxes) {
      if (this.watchers.has(m.id)) continue;
      if (this.watchers.size >= this.deps.maxConnections) break;
      const watcher = new Watcher(m, fingerprint(m), this.deps);
      this.watchers.set(m.id, watcher);
      watcher.start();
    }
  }

  states(): Map<string, { state: IdleState; since: Date }> {
    return new Map([...this.watchers].map(([id, w]) => [id, { state: w.state, since: w.since }]));
  }

  async stop(): Promise<void> {
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(all.map((w) => w.stop()));
  }
}

/** The real connection: imapflow, idling on the selected folder. */
export function createImapFlowIdleConnection(mailbox: IdleMailbox, secret: ImapSecret): IdleConnection {
  const client = new ImapFlow({
    host: mailbox.config.host,
    port: mailbox.config.port,
    secure: mailbox.config.tls,
    auth: imapAuth(mailbox.config.username, secret),
    logger: false,
    disableCompression: true,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    // Quiet is normal while idling; imapflow answers a socket timeout during
    // IDLE with a NOOP and only gives up if that goes unanswered.
    socketTimeout: 5 * 60_000,
    // Servers may end an IDLE after 29-30 minutes (RFC 2177); renew it first.
    maxIdleTime: 25 * 60_000,
  });
  // Without a listener an 'error' event would throw; the close handler below reports it.
  client.on("error", () => {});
  return {
    connect: () => client.connect(),
    async watch(folder) {
      const lock = await client.getMailboxLock(folder);
      lock.release();
    },
    onNewMail(listener) {
      client.on("exists", (data: { count: number; prevCount: number }) => {
        if (data.count > data.prevCount) listener();
      });
    },
    onClose(listener) {
      client.once("close", () => listener());
    },
    async close() {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref());
      await Promise.race([client.logout().catch(() => {}), timeout]);
      client.close();
    },
  };
}

/** Where the worker publishes each mailbox's IDLE state for the API (expires if the worker stops publishing). */
export const IDLE_STATE_KEY = "eumaeus:idle:state";
const IDLE_STATE_TTL_S = 180;

export async function publishIdleStates(redis: Redis, states: Map<string, { state: IdleState; since: Date }>): Promise<void> {
  const multi = redis.multi().del(IDLE_STATE_KEY);
  if (states.size > 0) {
    multi.hset(IDLE_STATE_KEY, Object.fromEntries([...states].map(([id, s]) => [id, JSON.stringify({ state: s.state, since: s.since.toISOString() })])));
    multi.expire(IDLE_STATE_KEY, IDLE_STATE_TTL_S);
  }
  await multi.exec();
}

export async function readIdleStates(redis: Redis): Promise<Map<string, { state: IdleState; since: string }>> {
  try {
    const raw = await redis.hgetall(IDLE_STATE_KEY);
    return new Map(Object.entries(raw).map(([id, v]) => [id, JSON.parse(v) as { state: IdleState; since: string }]));
  } catch {
    return new Map();
  }
}
