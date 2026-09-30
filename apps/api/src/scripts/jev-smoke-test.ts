import { loadEnv } from "../config/env.js";
import { prisma } from "../db/client.js";
import { ensureBootstrapMailbox } from "../modules/tenancy/bootstrap.js";
import { processEmailJobHandler } from "../queue/workers/processEmail.worker.js";
import { EmailState } from "../types/email-state.js";

/**
 * CLI entry point: `pnpm jev:smoke`.
 *
 * A real end-to-end check of the Jev integration against whatever
 * JEV_API_BASE_URL/JEV_API_KEY/JEV_MODEL_VERSION are configured — no fake/mock
 * client, no special-cased code path. It calls the SAME processEmailJobHandler
 * the worker uses for every real email.
 *
 * The one deliberate deviation from full production flow: since no real IMAP
 * mailbox is configured yet, this creates ONE synthetic Email row directly
 * (clearly marked below, never claiming to be real mail) instead of pulling from
 * `pnpm sync`. Everything downstream of that row's creation — the Jev HTTP call,
 * response validation, persistence, audit trail, state transition — is the real,
 * unmodified pipeline.
 */
async function main() {
  const env = loadEnv();
  console.log("[jev-smoke-test] JEV_API_BASE_URL:", env.JEV_API_BASE_URL);
  console.log("[jev-smoke-test] JEV_MODEL_VERSION (requested):", env.JEV_MODEL_VERSION);
  console.log("[jev-smoke-test] JEV_API_KEY present:", env.JEV_API_KEY.length > 0 ? "yes" : "NO — will fail");

  const { tenant, mailboxConnection } = await ensureBootstrapMailbox(env);

  const now = new Date();
  const email = await prisma.email.create({
    data: {
      tenantId: tenant.id,
      mailboxConnectionId: mailboxConnection.id,
      provider: "imap",
      externalId: `smoke-test-${Date.now()}`,
      uidValidity: 999999,
      fromAddress: "prospective-partner@example.com",
      toAddresses: [mailboxConnection.emailAddress],
      ccAddresses: [],
      bccAddresses: [],
      subject: "Potential partnership opportunity",
      textBody:
        "Hi, I represent a mid-size logistics company and we're interested in exploring a partnership " +
        "with your team for the upcoming quarter. Could we schedule a call this week to discuss details? " +
        "This is somewhat time-sensitive as we're finalizing vendor selection soon.",
      receivedAt: now,
      hasAttachments: false,
      state: EmailState.RECEIVED,
      stateUpdatedAt: now,
      ingestedAt: now,
    },
  });

  console.log(`\n[jev-smoke-test] Created SYNTHETIC test email ${email.id} — not from a real mailbox (none configured yet).`);
  console.log("[jev-smoke-test] Calling the real process-email job handler (a real HTTP request will be made)...\n");

  await processEmailJobHandler({ emailId: email.id });

  const refreshedEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  const analysis = await prisma.analysisResult.findFirst({ where: { emailId: email.id }, orderBy: { createdAt: "desc" } });
  const events = await prisma.auditEvent.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "asc" } });

  console.log("=== RESULT ===");
  console.log("Email state:", refreshedEmail.state);
  console.log("Audit trail:", events.map((e) => e.eventType).join(" -> "));

  if (analysis) {
    console.log("\nAnalysisResult:");
    console.log("  status:          ", analysis.status);
    console.log("  requested model: ", env.JEV_MODEL_VERSION);
    console.log("  returned model:  ", analysis.jevModel);
    console.log("  schema_version:  ", analysis.schemaVersion);
    console.log("  input_tokens:    ", analysis.inputTokens);
    console.log("  output_tokens:   ", analysis.outputTokens);
    console.log("  latency_ms:      ", analysis.latencyMs);
    if (analysis.status === "ok") {
      console.log("  answers:\n", JSON.stringify(analysis.answers, null, 2));
    } else {
      console.log("  error_class:     ", analysis.errorClass);
      console.log("  error_message:   ", analysis.errorMessage);
    }
  } else {
    console.log("\nNo AnalysisResult row was found.");
  }
}

main()
  .catch((error) => {
    console.error("\n[jev-smoke-test] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
