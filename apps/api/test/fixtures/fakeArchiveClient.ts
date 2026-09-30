import type { ImapArchiveClientPort, ImapArchiveMailboxStatus, ImapMoveResult } from "../../src/modules/mail-providers/imap/archiveClient.js";

export interface FakeArchiveClientOptions {
  uidValidity: number;
  /** UIDs currently present in the source folder — moveMessage() returns false for any UID not in this set (mirrors real IMAP's "no matching message" behavior). */
  presentUids: number[];
  failOnConnect?: Error;
  /** If set, moveMessage() rejects with this error instead of resolving, WITHOUT applying the move — simulates the request never being applied server-side (connection dropped before the server acted on it). */
  failOnMove?: Error;
  /**
   * If set, moveMessage() actually applies the move (removes the UID from
   * presentUids, exactly like a real success) and THEN rejects with this error
   * — simulates the server genuinely completing the MOVE before the connection
   * dropped and the tagged response was lost. This is the true "operation
   * succeeded but the response was lost" ambiguity, distinct from failOnMove's
   * "never applied" case: use `presentUids` (the getter below) afterward to
   * prove the fake's own state really changed, not just that it threw.
   */
  failOnMoveAfterApplying?: Error;
  /** Phase 15: what a UIDPLUS server reports for a move. Omit to simulate a server without UIDPLUS. */
  moveResult?: ImapMoveResult;
  /** Phase 15: Message-ID -> UID, per folder, for findUidByMessageId(). */
  messageIds?: Record<string, Record<string, number>>;
  gmail?: boolean;
  failOnFlags?: Error;
}

export class FakeArchiveClient implements ImapArchiveClientPort {
  constructor(private readonly options: FakeArchiveClientOptions) {}

  /** Test-only introspection: the source folder's current state as this fake sees it — lets a test prove a prior moveMessage() call genuinely mutated server-side state, not just that it threw. */
  get presentUids(): readonly number[] {
    return this.options.presentUids;
  }

  async connect(): Promise<void> {
    if (this.options.failOnConnect) throw this.options.failOnConnect;
  }

  /** Test-only introspection: every addFlags() and moveMessage() call, in order. */
  readonly calls: Array<{ op: "flags"; uid: number; flags: string[]; asGmailLabels: boolean; folder: string } | { op: "move"; uid: number; target: string; folder: string }> = [];
  private openFolder = "";

  async openMailbox(folder: string): Promise<ImapArchiveMailboxStatus> {
    this.openFolder = folder;
    return { uidValidity: this.options.uidValidity };
  }

  async addFlags(uid: number, flags: string[], options: { asGmailLabels?: boolean } = {}): Promise<boolean> {
    if (this.options.failOnFlags) throw this.options.failOnFlags;
    if (!this.options.presentUids.includes(uid)) return false;
    this.calls.push({ op: "flags", uid, flags, asGmailLabels: options.asGmailLabels === true, folder: this.openFolder });
    return true;
  }

  supportsGmailLabels(): boolean {
    return this.options.gmail === true;
  }

  async findUidByMessageId(messageId: string): Promise<number | null> {
    return this.options.messageIds?.[this.openFolder]?.[messageId] ?? null;
  }

  async moveMessage(uid: number, targetFolder: string): Promise<ImapMoveResult | false> {
    this.calls.push({ op: "move", uid, target: targetFolder, folder: this.openFolder });
    if (this.options.failOnMoveAfterApplying) {
      this.options.presentUids = this.options.presentUids.filter((u) => u !== uid);
      throw this.options.failOnMoveAfterApplying;
    }
    if (this.options.failOnMove) throw this.options.failOnMove;
    if (!this.options.presentUids.includes(uid)) return false;
    this.options.presentUids = this.options.presentUids.filter((u) => u !== uid);
    return this.options.moveResult ?? {};
  }

  async close(): Promise<void> {
    // no-op
  }
}
