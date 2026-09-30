import { prisma } from "../../db/client.js";

/**
 * 1.2 (G): is Jev working for this organization, and what is left behind
 * when it isn't? Read-only; the web app shows it and offers to ask Jev again
 * for the emails it couldn't analyze (the existing bulk reprocess).
 */
export interface JevStatus {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  /** The most recent error, if it is newer than the most recent success. */
  currentError: { httpStatus: number | null; message: string } | null;
  /** Jev refused the key or the plan (401/402/403) on the latest analysis. */
  accessDenied: boolean;
  /** Emails received more than WAITING_AFTER_MS ago and still not analyzed. */
  waiting: number;
  /** Emails whose latest analysis failed. */
  failed: number;
  /** Up to MAX_RETRY_IDS of them, newest first — what "ask Jev again" sends. */
  failedEmailIds: string[];
  last7Days: { ok: number; error: number; inputTokens: number };
}

export const WAITING_AFTER_MS = 2 * 60_000;
export const MAX_RETRY_IDS = 100;

export async function jevStatus(tenantId: string, now: Date = new Date()): Promise<JevStatus> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const [lastOk, lastError, waiting, failedRows, failedCount, week, tokens] = await Promise.all([
    prisma.analysisResult.findFirst({ where: { tenantId, status: "ok" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.analysisResult.findFirst({ where: { tenantId, status: "error" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, errorMessage: true } }),
    prisma.email.count({ where: { tenantId, state: { in: ["received", "analyzing"] }, ingestedAt: { lt: new Date(now.getTime() - WAITING_AFTER_MS) } } }),
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM email e
      JOIN LATERAL (SELECT a.status FROM analysis_result a WHERE a.email_id = e.id ORDER BY a.created_at DESC LIMIT 1) latest ON true
      WHERE e.tenant_id = ${tenantId} AND latest.status = 'error'
      ORDER BY e.received_at DESC
      LIMIT ${MAX_RETRY_IDS}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM email e
      JOIN LATERAL (SELECT a.status FROM analysis_result a WHERE a.email_id = e.id ORDER BY a.created_at DESC LIMIT 1) latest ON true
      WHERE e.tenant_id = ${tenantId} AND latest.status = 'error'`,
    prisma.analysisResult.groupBy({ by: ["status"], where: { tenantId, createdAt: { gte: weekAgo } }, _count: { _all: true } }),
    prisma.analysisResult.aggregate({ where: { tenantId, createdAt: { gte: weekAgo } }, _sum: { inputTokens: true } }),
  ]);

  const errorIsCurrent = lastError && (!lastOk || lastError.createdAt > lastOk.createdAt);
  const http = errorIsCurrent ? /Unexpected Jev HTTP status (\d{3})\b[:\s]*(.*)/s.exec(lastError.errorMessage ?? "") : null;
  const httpStatus = http ? Number(http[1]) : null;
  const message = errorIsCurrent ? (http ? (/"message"\s*:\s*"([^"]+)"/.exec(http[2] ?? "")?.[1] ?? http[2] ?? "") : (lastError.errorMessage ?? "")).slice(0, 300) : "";

  return {
    lastSuccessAt: lastOk?.createdAt.toISOString() ?? null,
    lastErrorAt: lastError?.createdAt.toISOString() ?? null,
    currentError: errorIsCurrent ? { httpStatus, message } : null,
    accessDenied: httpStatus === 401 || httpStatus === 402 || httpStatus === 403,
    waiting,
    failed: Number(failedCount[0]?.n ?? 0),
    failedEmailIds: failedRows.map((r) => r.id),
    last7Days: {
      ok: week.find((w) => w.status === "ok")?._count._all ?? 0,
      error: week.find((w) => w.status === "error")?._count._all ?? 0,
      inputTokens: tokens._sum.inputTokens ?? 0,
    },
  };
}
