import { prisma } from "../../db/client.js";

/**
 * What counts as "needs attention" (Phase 18). Each check returns the
 * conditions true RIGHT NOW for one organization; evaluateAlerts.ts turns them
 * into alerts that open and resolve on their own.
 */
export interface AlertCondition {
  kind: AlertKind;
  /** What it's about (a mailbox id), or "" for organization-wide. */
  subjectKey: string;
  /** English; kept for webhooks. The web app and emails build their own text from kind + params (alertText.ts). */
  title: string;
  detail: string;
  params: Record<string, string | number>;
}

export type AlertKind = "mailbox_sync_failing" | "mailbox_reauth_required" | "action_failures" | "jev_errors" | "jev_access_denied" | "forward_failures";

const MIN = 60_000;
/** A mailbox failing for this long without a success is worth a person's time; one failed poll isn't. */
export const SYNC_FAILING_FOR_MS = 30 * MIN;
export const WINDOW_MS = 60 * MIN;
export const MIN_ACTIONS = 5;
export const MIN_ANALYSES = 5;
export const FAILURE_SHARE = 0.5;

export async function currentConditions(tenantId: string, now: Date): Promise<AlertCondition[]> {
  const conditions: AlertCondition[] = [];
  const since = new Date(now.getTime() - WINDOW_MS);

  const mailboxes = await prisma.mailboxConnection.findMany({ where: { tenantId, status: { in: ["active", "reauth_required"] } } });
  for (const m of mailboxes) {
    if (m.status === "reauth_required") {
      conditions.push({
        kind: "mailbox_reauth_required",
        subjectKey: m.id,
        title: `Sign-in expired for ${m.emailAddress}`,
        detail: "No mail is being collected from this mailbox. Open Mailboxes and choose Reconnect.",
        params: { mailbox: m.emailAddress },
      });
      continue;
    }
    const lastSuccess = m.lastSyncSuccessAt?.getTime() ?? 0;
    const lastFailure = m.lastSyncFailureAt?.getTime() ?? 0;
    const failingSince = lastSuccess || m.createdAt.getTime();
    if (lastFailure > lastSuccess && now.getTime() - failingSince >= SYNC_FAILING_FOR_MS) {
      conditions.push({
        kind: "mailbox_sync_failing",
        subjectKey: m.id,
        title: `${m.emailAddress} can't be synced`,
        detail: `No successful sync ${lastSuccess ? `since ${new Date(lastSuccess).toISOString()}` : "yet"}. Last error: ${m.lastSyncError ?? "unknown"}`,
        params: { mailbox: m.emailAddress, since: lastSuccess ? new Date(lastSuccess).toISOString() : "", error: m.lastSyncError ?? "" },
      });
    }
  }

  const executions = await prisma.actionExecution.groupBy({
    by: ["status"],
    where: { tenantId, createdAt: { gte: since }, channelType: { not: "archive_undo" } },
    _count: { _all: true },
  });
  const total = executions.reduce((n, e) => n + e._count._all, 0);
  const failed = executions.filter((e) => e.status === "failed" || e.status === "ambiguous").reduce((n, e) => n + e._count._all, 0);
  if (total >= MIN_ACTIONS && failed / total >= FAILURE_SHARE) {
    conditions.push({
      kind: "action_failures",
      subjectKey: "",
      title: `${failed} of ${total} actions failed in the last hour`,
      detail: "Moves, forwards or webhooks are failing. The emails involved are in Human Review; the failed actions are listed on each email's page.",
      params: { failed, total },
    });
  }

  const analyses = await prisma.analysisResult.groupBy({ by: ["status"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } });
  const analysed = analyses.reduce((n, a) => n + a._count._all, 0);
  const errors = analyses.find((a) => a.status === "error")?._count._all ?? 0;
  if (analysed >= MIN_ANALYSES && errors / analysed >= FAILURE_SHARE) {
    conditions.push({
      kind: "jev_errors",
      subjectKey: "",
      title: `Jev couldn't analyze ${errors} of ${analysed} emails in the last hour`,
      detail: "Unanalyzed emails go to Human Review. This is usually a temporary problem at Jev; it clears on its own when analyses succeed again.",
      params: { errors, analysed },
    });
  }

  // Jev refusing the key or the plan (401/402/403 — no credits, model not in
  // the plan, revoked key) won't clear by itself, and every new email ends up
  // unanalyzed. One refusal is enough — this must not wait for the volume the
  // rate-based check above needs. Open until the next analysis succeeds.
  const latest = await prisma.analysisResult.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: { status: true, errorMessage: true } });
  const refused = latest?.status === "error" ? /Unexpected Jev HTTP status (401|402|403)\b[:\s]*(.*)/s.exec(latest.errorMessage ?? "") : null;
  if (refused) {
    const reason = (/"message"\s*:\s*"([^"]+)"/.exec(refused[2] ?? "")?.[1] ?? refused[2] ?? "").slice(0, 200);
    conditions.push({
      kind: "jev_access_denied",
      subjectKey: "",
      title: `Jev is refusing requests (HTTP ${refused[1]})`,
      detail: `New emails can't be analyzed and go to Human Review. Jev said: "${reason}". Check the Jev account (plan, credits, key). After fixing it, reprocess those emails with "Ask Jev again".`,
      params: { status: refused[1] ?? "", reason },
    });
  }

  const [digestFailures, forwardFailures] = await Promise.all([
    prisma.forwardDigestBatch.count({ where: { tenantId, status: { in: ["failed", "ambiguous"] }, completedAt: { gte: since } } }),
    prisma.actionExecution.count({ where: { tenantId, channelType: "forward", status: { in: ["failed", "ambiguous"] }, retryable: { not: true }, createdAt: { gte: since } } }),
  ]);
  if (digestFailures > 0 || forwardFailures >= 3) {
    conditions.push({
      kind: "forward_failures",
      subjectKey: "",
      title: "Forwarding is failing",
      detail: `${forwardFailures} forward(s) and ${digestFailures} digest(s) could not be sent in the last hour. Check Settings › Send test email and the forward recipients on Destinations.`,
      params: { forwards: forwardFailures, digests: digestFailures },
    });
  }

  return conditions;
}
