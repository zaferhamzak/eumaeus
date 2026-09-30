/**
 * One-off operator script: reprocesses ALREADY-ANALYZED emails of one
 * organization with today's rules, using the system's own
 * reprocessEmail() (modules/reprocess) rather than deleting state.
 *
 * Why not delete RoutingDecision rows: Phase 18 added superseding. The live
 * reprocess path keeps the old decision (superseded_at stamped), closes open
 * Human Review items, re-evaluates, and dispatches — so the audit trail of
 * "this used to go here, now it goes there" survives, and an API/service
 * change can't desync this script from the product.
 *
 * reprocessEmail() refuses with moved_elsewhere when an earlier decision
 * already moved the message; this script reports those per-email and keeps
 * going, because a refused email is left untouched, not corrupted.
 *
 * Jev is never called — the stored AnalysisResult is reused.
 * Requires the worker process to run: dispatch enqueues, the execute-action
 * worker does the IMAP moves.
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/reprocess-all-once.ts <tenantId> [--limit N] [--yes]
 */
import { prisma } from "../db/client.js";
import { reprocessEmail, ReprocessRefusedError } from "../modules/reprocess/reprocessEmail.js";
import { closeExecuteActionQueue } from "../queue/executeActionQueue.js";

const args = process.argv.slice(2);
const tenantId = args[0];
const limitIdx = args.indexOf("--limit");
const limit = limitIdx === -1 ? undefined : Number(args[limitIdx + 1]);
const confirmed = args.includes("--yes");

if (!tenantId) {
  console.error("usage: tsx reprocess-all-once.ts <tenantId> [--limit N] [--yes]");
  process.exit(1);
}

const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
if (!tenant) {
  console.error(`no tenant with id ${tenantId}`);
  process.exit(1);
}

const emails = await prisma.email.findMany({
  where: { tenantId, analysisResults: { some: { status: "ok" } } },
  orderBy: { receivedAt: "asc" },
  ...(limit ? { take: limit } : {}),
  select: { id: true, subject: true, fromAddress: true },
});

const activeRules = await prisma.rule.count({ where: { tenantId, enabled: true, deactivatedAt: null } });
const openBefore = await prisma.humanReviewItem.count({ where: { tenantId, status: "open" } });

console.log(`organizasyon : ${tenant.name}`);
console.log(`aktif kural  : ${activeRules}`);
console.log(`email        : ${emails.length}`);
console.log(`acik human review (kapatilacak): ${openBefore}`);
console.log(`esik         : ${tenant.humanReviewSignalEnabled ? tenant.humanReviewSignalThreshold : "kapali"}`);
console.log(`mod: ${confirmed ? "UYGULA" : "DRY-RUN (sadece gosterir)"}\n`);

if (!confirmed) {
  console.log("Hicbir sey degistirilmedi. Gercekten uygulamak icin --yes ekleyin.");
  await prisma.$disconnect();
  process.exit(0);
}

const tally = new Map<string, number>();
const refused = new Map<string, number>();
let errors = 0;

for (const [index, email] of emails.entries()) {
  try {
    const result = await reprocessEmail(tenantId, email.id, "system:reprocess-all-once");
    const key = result.decision.destinationRef ?? result.decision.status;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  } catch (error) {
    if (error instanceof ReprocessRefusedError) {
      refused.set(error.code, (refused.get(error.code) ?? 0) + 1);
    } else {
      errors++;
      console.log(`HATA ${email.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if ((index + 1) % 50 === 0) console.log(`  ...${index + 1}/${emails.length}`);
}

console.log(`\n--- sonuc (yeni kararlar)`);
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
if (refused.size > 0) {
  console.log(`\nreddedilen (dokunulmadi):`);
  for (const [code, n] of refused) console.log(`  ${n}\t${code}`);
}
console.log(`hata: ${errors}`);

const openAfter = await prisma.humanReviewItem.count({ where: { tenantId, status: "open" } });
console.log(`\nacik human review: ${openBefore} -> ${openAfter}`);
console.log(
  "Tasimalar execute-action worker'i tarafindan yapilir. " +
    "Kontrol: action_execution ve IMAP klasor sayilari.",
);

await closeExecuteActionQueue();
await prisma.$disconnect();
