/**
 * One-off operator script: counts messages per IMAP folder, so a routing run
 * can be verified against what actually happened on the server (not just what
 * the DB believes). Read-only.
 *
 *   pnpm --filter api tsx --env-file=.env src/scripts/count-folder-messages-once.ts <mailboxConnectionId>
 */
import { ImapFlow } from "imapflow";
import { prisma } from "../db/client.js";
import { resolveMailboxPassword } from "../modules/mail-providers/imap/mailboxCredentials.js";

const mailboxConnectionId = process.argv[2];
if (!mailboxConnectionId) {
  console.error("usage: tsx count-folder-messages-once.ts <mailboxConnectionId>");
  process.exit(1);
}

const mailbox = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnectionId } });
const password = await resolveMailboxPassword(mailbox.tenantId, mailboxConnectionId);
const config = mailbox.providerConfig as { host: string; port: number; tls: boolean; username: string };

const client = new ImapFlow({
  host: config.host,
  port: config.port,
  secure: config.tls,
  auth: { user: config.username, pass: password },
  logger: false,
});

await client.connect();
const boxes = (await client.list()) ?? [];
for (const box of boxes) {
  const lock = await client.getMailboxLock(box.path);
  try {
    const mailboxInfo = client.mailbox;
    if (!mailboxInfo || typeof mailboxInfo === "boolean") continue;
    console.log(`${box.path}\t${mailboxInfo.exists}`);
  } finally {
    lock.release();
  }
}
await client.logout();
await prisma.$disconnect();
