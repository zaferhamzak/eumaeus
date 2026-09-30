import { prisma } from "../../../db/client.js";
import { resolveMailboxSecret, type ImapSecret } from "../../mail-providers/imap/mailboxAuth.js";
import { OAuthError } from "../../mail-providers/oauth/tokens.js";
import { ImapFlowArchiveClient, type ImapArchiveClientPort } from "../../mail-providers/imap/archiveClient.js";
import type { ImapFlagOptions } from "../types.js";
import type { ExecutionOutcome } from "./types.js";

/**
 * The shared setup for every executor that acts on a message in its mailbox
 * over IMAP (archive, flag, and undoing an archive): resolve the mailbox's
 * connection settings and its own credential, and build a client. One of the
 * few files in modules/destinations/ allowed to depend on
 * modules/mail-providers/imap/ (test/architecture/destinationsModuleBoundary.test.ts).
 */
export interface ProviderConfig {
  host: string;
  port: number;
  tls: boolean;
  folder: string;
  username: string;
}

export type ArchiveClientFactory = (config: ProviderConfig, password: string) => ImapArchiveClientPort;

export type ImapSession = { ok: true; client: ImapArchiveClientPort; config: ProviderConfig } | { ok: false; outcome: ExecutionOutcome };

export async function openImapSession(mailboxConnectionId: string, clientFactory?: ArchiveClientFactory): Promise<ImapSession> {
  const mailboxConnection = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId } });
  if (!mailboxConnection) {
    return { ok: false, outcome: { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: `MailboxConnection ${mailboxConnectionId} no longer exists` } };
  }
  const config = mailboxConnection.providerConfig as unknown as ProviderConfig;

  let secret: ImapSecret;
  try {
    // Each mailbox's OWN credential — its password, or a fresh OAuth access
    // token (Phase 17) — same resolution as sync.ts. A missing credential or a
    // revoked sign-in is a configuration problem, not a transient connection
    // issue, so it fails permanently.
    secret = await resolveMailboxSecret(mailboxConnection);
  } catch (credentialError) {
    const message = credentialError instanceof Error ? credentialError.message : String(credentialError);
    // A token refresh that failed on the network is transient; a missing
    // credential or a revoked sign-in needs a person.
    if (credentialError instanceof OAuthError) {
      return { ok: false, outcome: { status: "failed", retryable: true, errorClass: "connection", errorMessage: `Could not refresh the mailbox sign-in: ${message}` } };
    }
    return { ok: false, outcome: { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: message } };
  }

  const client = clientFactory
    ? clientFactory(config, secret.value)
    : new ImapFlowArchiveClient({ host: config.host, port: config.port, tls: config.tls, username: config.username, secret });
  return { ok: true, client, config };
}

/**
 * Applies ImapFlagOptions to one message. System flags and keywords are
 * separate STOREs because on Gmail keywords go through X-GM-LABELS. Returns
 * false if the message isn't in the open folder.
 */
export async function applyFlags(client: ImapArchiveClientPort, uid: number, options: ImapFlagOptions, timeoutMs: number): Promise<boolean> {
  const system = [...(options.markSeen ? ["\\Seen"] : []), ...(options.flagged ? ["\\Flagged"] : [])];
  const keywords = options.keywords ?? [];
  let present = true;
  if (system.length > 0) present = await withTimeout(client.addFlags(uid, system), timeoutMs, "addFlags");
  if (present && keywords.length > 0) {
    present = await withTimeout(client.addFlags(uid, keywords, { asGmailLabels: client.supportsGmailLabels() }), timeoutMs, "addFlags");
  }
  return present;
}

export function hasFlagOptions(options: ImapFlagOptions): boolean {
  return Boolean(options.markSeen || options.flagged || (options.keywords && options.keywords.length > 0));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IMAP ${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
