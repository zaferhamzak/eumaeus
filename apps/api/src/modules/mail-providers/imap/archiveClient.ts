import { ImapFlow } from "imapflow";
import { imapAuth, type ImapSecret } from "./mailboxAuth.js";

export interface ImapArchiveMailboxStatus {
  uidValidity: number;
}

/**
 * Where a moved message landed (Phase 15). Both fields come from the
 * server's COPYUID response, which only servers with the UIDPLUS extension
 * send — they're undefined otherwise, and callers fall back to searching by
 * Message-ID.
 */
export interface ImapMoveResult {
  targetUid?: number;
  targetUidValidity?: number;
}

/**
 * A second, separate, deliberately narrow IMAP port — NOT an extension of
 * ImapClientPort (client.ts), because archiving is a genuinely different concern
 * from ingestion/fetching. Mirrors client.ts's own stated philosophy exactly:
 * narrow, provider-specific, injectable for tests, not a generic capability bag.
 *
 * Used ONLY by modules/destinations/executors/archiveExecutor.ts — see that
 * file's docs and test/architecture/destinationsModuleBoundary.test.ts for the
 * enforced rule that no other file in modules/destinations/ touches IMAP.
 */
export interface ImapArchiveClientPort {
  connect(): Promise<void>;
  openMailbox(folder: string): Promise<ImapArchiveMailboxStatus>;
  /**
   * Moves the message with the given UID into targetFolder.
   *
   * Returns where it landed (see ImapMoveResult) if a message was actually
   * moved, `false` if no message with
   * that UID exists in the currently-open mailbox — which, for Eumaeus's
   * purposes, means "already archived" (by this or an earlier attempt): IMAP UID
   * commands do not error on a non-existent UID, they simply match nothing. This
   * is the mechanism the archive executor uses to safely recognize an
   * already-completed archive without guessing (see archiveExecutor.ts).
   *
   * Rejects (throws) if the outcome could not be determined — most importantly,
   * if the connection fails or the command errors AFTER being sent but before a
   * response is received. The caller (archiveExecutor.ts), not this port,
   * decides what that ambiguity means operationally.
   */
  moveMessage(uid: number, targetFolder: string): Promise<ImapMoveResult | false>;
  /**
   * Phase 15: adds flags (\\Seen, \\Flagged, custom keywords) to a message in
   * the open mailbox. With `asGmailLabels`, keywords are applied as Gmail
   * labels (X-GM-LABELS) instead. Adding a flag that's already set is a no-op,
   * so this is safe to repeat. Resolves false when no message has that UID.
   */
  addFlags(uid: number, flags: string[], options?: { asGmailLabels?: boolean }): Promise<boolean>;
  /** Phase 15: the server supports Gmail's IMAP extensions (labels). */
  supportsGmailLabels(): boolean;
  /** Phase 15: UID of the message with this Message-ID in the open mailbox, or null. Used when the server didn't report where a moved message landed. */
  findUidByMessageId(messageId: string): Promise<number | null>;
  close(): Promise<void>;
}

export interface ImapArchiveConnectionConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  /** Phase 17: the password, or an OAuth access token (XOAUTH2). */
  secret: ImapSecret;
}

export class ImapFlowArchiveClient implements ImapArchiveClientPort {
  private client: ImapFlow;

  constructor(config: ImapArchiveConnectionConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: imapAuth(config.username, config.secret),
      logger: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async openMailbox(folder: string): Promise<ImapArchiveMailboxStatus> {
    const lock = await this.client.getMailboxLock(folder);
    lock.release();
    const mailbox = this.client.mailbox;
    if (!mailbox || typeof mailbox === "boolean") {
      throw new Error(`Failed to open IMAP folder "${folder}"`);
    }
    return { uidValidity: Number(mailbox.uidValidity) };
  }

  async moveMessage(uid: number, targetFolder: string): Promise<ImapMoveResult | false> {
    const result = await this.client.messageMove([uid], targetFolder, { uid: true });
    if (result === false) return false;
    return {
      targetUid: result.uidMap?.get(uid),
      targetUidValidity: result.uidValidity !== undefined ? Number(result.uidValidity) : undefined,
    };
  }

  async addFlags(uid: number, flags: string[], options: { asGmailLabels?: boolean } = {}): Promise<boolean> {
    if (flags.length === 0) return true;
    return this.client.messageFlagsAdd([uid], flags, { uid: true, useLabels: options.asGmailLabels === true });
  }

  supportsGmailLabels(): boolean {
    return this.client.capabilities.has("X-GM-EXT-1");
  }

  async findUidByMessageId(messageId: string): Promise<number | null> {
    const uids = await this.client.search({ header: { "message-id": messageId } }, { uid: true });
    return uids && uids.length > 0 ? uids[uids.length - 1]! : null;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}
