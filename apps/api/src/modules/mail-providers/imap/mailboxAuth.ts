import { resolveMailboxPassword } from "./mailboxCredentials.js";
import { getFreshAccessToken } from "../oauth/tokens.js";

/**
 * What an IMAP client signs in with (Phase 17): the mailbox's own password,
 * or — for a mailbox connected with Google / Microsoft — a fresh OAuth access
 * token, used via XOAUTH2. The ONE place both are resolved; like the password,
 * the token is used immediately and never stored beyond this call.
 */
export type ImapSecret = { kind: "password"; value: string } | { kind: "accessToken"; value: string };

export async function resolveMailboxSecret(mailbox: { id: string; tenantId: string; authType: string }): Promise<ImapSecret> {
  if (mailbox.authType === "password") return { kind: "password", value: await resolveMailboxPassword(mailbox.tenantId, mailbox.id) };
  return { kind: "accessToken", value: await getFreshAccessToken(mailbox.id) };
}

/** imapflow's `auth` option for a secret. */
export function imapAuth(username: string, secret: ImapSecret): { user: string; pass: string } | { user: string; accessToken: string } {
  return secret.kind === "password" ? { user: username, pass: secret.value } : { user: username, accessToken: secret.value };
}
