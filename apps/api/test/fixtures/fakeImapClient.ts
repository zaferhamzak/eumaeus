import type { ImapClientPort, ImapMailboxStatus, ImapMessageSource } from "../../src/modules/mail-providers/imap/client.js";

export interface FakeImapMessage {
  uid: number;
  source: Buffer;
}

export interface FakeImapClientOptions {
  uidValidity: number;
  uidNext: number;
  messages: FakeImapMessage[];
  /** If set, `connect()` throws this instead of succeeding — for failure-path tests. */
  failOnConnect?: Error;
  /**
   * Artificial delay (ms) inside fetchMessagesFrom, between yielding each message.
   * Used only to widen the race window in concurrency tests so a second, truly
   * concurrent syncMailbox() call has time to observe the mailbox-level lock while
   * the first one is still "in progress."
   */
  fetchDelayMs?: number;
}

/**
 * In-memory stand-in for ImapFlowMailClient, used by every test in this suite so
 * that none of them need a real mailbox (this phase's explicit test requirement).
 */
export class FakeImapClient implements ImapClientPort {
  constructor(private readonly options: FakeImapClientOptions) {}

  async connect(): Promise<void> {
    if (this.options.failOnConnect) {
      throw this.options.failOnConnect;
    }
  }

  async openMailbox(_folder: string): Promise<ImapMailboxStatus> {
    return { uidValidity: this.options.uidValidity, uidNext: this.options.uidNext };
  }

  async *fetchMessagesFrom(startUid: number): AsyncIterable<ImapMessageSource> {
    for (const message of this.options.messages) {
      if (message.uid < startUid) continue;
      if (this.options.fetchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.fetchDelayMs));
      }
      yield { uid: message.uid, uidValidity: this.options.uidValidity, source: message.source };
    }
  }

  async close(): Promise<void> {
    // no-op
  }
}
