/**
 * One-off diagnostic: opens a raw IMAP connection for ONE mailbox and reports
 * the real login error, instead of the generic "Command failed" the worker
 * surfaces. Use when a mailbox was created OK but sync never succeeds.
 *
 *   pnpm --filter api tsx --env-file=.env src/scripts/test-imap-login-once.ts <mailboxConnectionId>
 */
import { ImapFlow } from "imapflow";
import { prisma } from "../db/client.js";
import { resolveMailboxPassword } from "../modules/mail-providers/imap/mailboxCredentials.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: tsx test-imap-login-once.ts <mailboxConnectionId>");
  process.exit(1);
}

const mailbox = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id } });
const config = mailbox.providerConfig as { host: string; port: number; tls: boolean; username: string; folder?: string };
console.log(`mailbox : ${mailbox.emailAddress}`);
console.log(`host    : ${config.username}@${config.host}:${config.port} tls=${config.tls}`);

let password = "";
try {
  password = await resolveMailboxPassword(mailbox.tenantId, id);
  console.log(`parola  : cozuldu (${password.length} karakter)`);
} catch (error) {
  console.log(`parola  : COZULEMEDI -> ${error instanceof Error ? error.message : String(error)}`);
  await prisma.$disconnect();
  process.exit(1);
}

const client = new ImapFlow({
  host: config.host,
  port: config.port,
  secure: config.tls,
  auth: { user: config.username, pass: password },
  logger: false,
});

try {
  await client.connect();
  console.log("LOGIN   : basarili");
  const boxes = (await client.list()) ?? [];
  console.log(`klasor  : ${boxes.length} adet -> ${boxes.map((b) => b.path).join(", ")}`);
  const lock = await client.getMailboxLock(config.folder ?? "INBOX");
  try {
    const box = client.mailbox;
    if (box && typeof box !== "boolean") console.log(`INBOX   : ${box.exists} mesaj`);
  } finally {
    lock.release();
  }
  await client.logout();
  console.log("\nSONUC: baglanti saglam");
} catch (error) {
  const e = error as { responseStatus?: string; responseText?: string; message?: string };
  console.log(`LOGIN   : BASARISIZ`);
  console.log(`  durum : ${e.responseStatus ?? "-"}`);
  console.log(`  yanit : ${e.responseText ?? "-"}`);
  console.log(`  mesaj : ${e.message ?? String(error)}`);
  process.exitCode = 1;
}

await prisma.$disconnect();
