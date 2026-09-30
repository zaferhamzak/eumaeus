/**
 * One-off operator script: creates the IMAP folders a mailbox's
 * archive-channel destinations point at (imapflow's messageMove requires the
 * target folder to exist). Idempotent — an existing folder is reported, not
 * an error. Trailing `--delete <folder...>` removes folders instead.
 *
 *   pnpm --filter api tsx --env-file=.env src/scripts/ensure-folders-once.ts <mailboxConnectionId> [folder...] [--delete folder...]
 */
import { ImapFlow } from "imapflow";
import { prisma } from "../db/client.js";
import { resolveMailboxPassword } from "../modules/mail-providers/imap/mailboxCredentials.js";

const [mailboxConnectionId, ...rest] = process.argv.slice(2);
const deleteIdx = rest.indexOf("--delete");
const deleteFolders = deleteIdx === -1 ? [] : rest.slice(deleteIdx + 1);
const folders = deleteIdx === -1 ? rest : rest.slice(0, deleteIdx);
if (!mailboxConnectionId || (folders.length === 0 && deleteFolders.length === 0)) {
  console.error("usage: tsx ensure-folders-once.ts <mailboxConnectionId> [folder...] [--delete folder...]");
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
const existing = new Set((await client.list())?.map((b) => b.path) ?? []);

for (const folder of folders) {
  if (existing.has(folder)) {
    console.log(`exists  ${folder}`);
    continue;
  }
  try {
    await client.mailboxCreate(folder);
    console.log(`created ${folder}`);
  } catch (error) {
    console.log(`FAILED  ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (deleteFolders.length > 0) {
  for (const folder of deleteFolders) {
    try {
      await client.mailboxDelete(folder);
      console.log(`deleted ${folder}`);
    } catch (error) {
      console.log(`FAILED  delete ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await client.logout();
await prisma.$disconnect();
