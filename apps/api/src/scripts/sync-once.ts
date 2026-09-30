import { loadEnv } from "../config/env.js";
import { ensureBootstrapMailbox } from "../modules/tenancy/bootstrap.js";
import { syncMailbox } from "../modules/mail-providers/imap/sync.js";
import { prisma } from "../db/client.js";

/**
 * CLI entry point: `pnpm sync`.
 *
 * Runs a single, manually-triggered synchronization pass against the mailbox
 * configured in .env and exits. Since Phase 2, this is one of TWO callers of
 * syncMailbox() — the other being the durable reconciliation scheduler that runs
 * inside `pnpm worker` — both go through the exact same function and the same
 * mailbox-level lock, so running this manually while the worker is also running is
 * safe: whichever gets there first wins, and this command will report that clearly
 * (see the "skipped" case below) rather than silently doing nothing.
 */
async function main() {
  const env = loadEnv();
  const { mailboxConnection } = await ensureBootstrapMailbox(env);

  console.log(`[sync] syncing mailbox ${mailboxConnection.emailAddress} (${mailboxConnection.id})...`);

  const result = await syncMailbox(mailboxConnection.id);

  if (result.skipped) {
    console.log(`[sync] skipped — ${result.skipReason}.`);
    return;
  }

  console.log(
    `[sync] done. discovered=${result.discovered} alreadyKnown=${result.alreadyKnown}` +
      (result.uidValidityChanged ? " (UIDVALIDITY changed — see MAILBOX_UIDVALIDITY_CHANGED audit event)" : ""),
  );
}

main()
  .catch((error) => {
    console.error("[sync] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
