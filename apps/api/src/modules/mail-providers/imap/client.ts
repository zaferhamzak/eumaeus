import { ImapFlow } from "imapflow";
import { imapAuth, type ImapSecret } from "./mailboxAuth.js";

export interface ImapMessageSource {
  uid: number;
  uidValidity: number;
  source: Buffer;
}

export interface ImapMailboxStatus {
  uidValidity: number;
  uidNext: number;
}

/**
 * The one seam in the IMAP path that Phase 1's tests need (implementation-plan.md
 * §V / this phase's brief: "Do NOT require my real mailbox credentials for tests").
 *
 * This is deliberately narrow and IMAP-specific — it is NOT a generic
 * "MailProvider"/"EmailProvider" interface meant to also fit a future Gmail
 * connector. When Gmail is added, it gets its own client module with whatever shape
 * the Gmail API actually needs; only the output of the whole provider (a
 * NormalizedEmail, see types/normalized-email.ts) is shared.
 */
export interface ImapClientPort {
  connect(): Promise<void>;
  openMailbox(folder: string): Promise<ImapMailboxStatus>;
  /** Fetches full message source for every UID >= startUid, in ascending UID order. */
  fetchMessagesFrom(startUid: number): AsyncIterable<ImapMessageSource>;
  close(): Promise<void>;
}

export interface ImapConnectionConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  /** Phase 17: the password, or an OAuth access token (XOAUTH2) — see mailboxAuth.ts. */
  secret: ImapSecret;
}

export class ImapFlowMailClient implements ImapClientPort {
  private client: ImapFlow;
  private mailboxStatus: ImapMailboxStatus | undefined;

  constructor(config: ImapConnectionConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: imapAuth(config.username, config.secret),
      logger: false,
      // imapflow negotiates COMPRESS on its own during setup; if the socket
      // drops right then, that rejection escapes (nobody awaits it) and took
      // the worker down once. Compression buys us nothing for short syncs.
      disableCompression: true,
      // Explicit, short timeouts: a server that stops answering must fail this
      // sync (the next one retries in a minute), not hang it — the library
      // defaults allow minutes of silence.
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 90_000,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async openMailbox(folder: string): Promise<ImapMailboxStatus> {
    const lock = await this.client.getMailboxLock(folder);
    lock.release();
    const mailbox = this.client.mailbox;
    if (!mailbox || typeof mailbox === "boolean") {
      throw new Error(`Failed to open IMAP folder "${folder}"`);
    }
    this.mailboxStatus = { uidValidity: Number(mailbox.uidValidity), uidNext: mailbox.uidNext };
    return this.mailboxStatus;
  }

  async *fetchMessagesFrom(startUid: number): AsyncIterable<ImapMessageSource> {
    if (!this.mailboxStatus) {
      throw new Error("openMailbox must be called before fetchMessagesFrom");
    }
    const uidValidity = this.mailboxStatus.uidValidity;
    // UID range with an open upper bound: "startUid:*" means "startUid through the
    // highest UID currently in the mailbox" per RFC 3501.
    const range = `${startUid}:*`;
    for await (const message of this.client.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (!message.source) continue;
      // A "startUid:*" range can legitimately return the message at startUid-1 or
      // similar edge results on some servers when nothing matches; guard explicitly
      // rather than trusting the range math blindly.
      if (message.uid < startUid) continue;
      yield { uid: message.uid, uidValidity, source: message.source };
    }
  }

  async close(): Promise<void> {
    // LOGOUT is a courtesy; if the server doesn't answer, drop the socket.
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000).unref());
    const result = await Promise.race([this.client.logout().then(() => "ok" as const), timeout]);
    if (result === "timeout") this.client.close();
  }
}
