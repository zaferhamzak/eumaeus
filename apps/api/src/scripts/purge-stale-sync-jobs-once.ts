/**
 * One-off maintenance: drop BullMQ failed-job entries that point at mailbox
 * connections which no longer exist (or are disabled).
 *
 * Why this is needed: a repeatable `mailbox-sync` job survives its mailbox, so
 * deleting a mailbox leaves the job firing forever. Those retries accumulated
 * into thousands of permanently-failed entries that no longer correspond to any
 * real work. syncMailbox() now skips a missing mailbox instead of throwing, but
 * the existing backlog still has to be swept once.
 *
 *   pnpm --filter api tsx --env-file=.env src/scripts/purge-stale-sync-jobs-once.ts [--dry-run]
 */
import { Queue } from "bullmq";
import { prisma } from "../db/client.js";
import { getRedisConnection } from "../queue/connection.js";

const QUEUES = ["mailbox-sync", "process-email", "execute-action"] as const;
const dryRun = process.argv.includes("--dry-run");

const mailbox = await prisma.mailboxConnection.findMany({
  select: { id: true, status: true },
});
// Only a mailbox that is both present and active is worth syncing; a repeatable
// job for a deleted or disabled mailbox can only ever fail.
const alive = new Set(mailbox.filter((m) => m.status === "active").map((m) => m.id));
console.log(`aktif mailbox: ${alive.size} / toplam ${mailbox.length}`);

const connection = getRedisConnection();
let totalRemoved = 0;

for (const name of QUEUES) {
  const queue = new Queue(name, { connection });
  const failed = await queue.getFailed(0, 20_000);
  // A repeatable sync job is named `repeat:<queue>:<mailboxId>:<ts>`; a
  // process-email job carries the mailbox id in its data instead.
  const stale = failed.filter((job) => {
    const haystack = `${job.name ?? ""} ${JSON.stringify(job.data ?? {})}`;
    const ids = haystack.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    return ids.length > 0 && ids.every((id) => !alive.has(id));
  });

  console.log(`\n${name}: toplam=${failed.length} silinmiş=${stale.length}`);
  if (stale.length === 0) continue;

  if (!dryRun) {
    for (const job of stale) await job.remove();
    totalRemoved += stale.length;
    console.log(`  ${stale.length} eski job temizlendi`);
  } else {
    console.log(`  (dry-run) temizlenecek: ${stale.length}`);
  }
  await queue.close();
}

console.log(`\ntoplam temizlenen: ${dryRun ? 0 : totalRemoved}`);
await prisma.$disconnect();
await getRedisConnection().quit();
