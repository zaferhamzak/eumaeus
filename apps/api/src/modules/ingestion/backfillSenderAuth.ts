import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { senderAuthFromRawSource } from "./senderAuth.js";

/**
 * Fills in the SPF / DKIM / DMARC verdict for mail ingested before it was
 * captured (0.27) — but only where the original message is still stored
 * (email_source keeps it for the organization's raw-source retention, 14
 * days by default). Older mail stays "unknown". Run by the maintenance tick
 * in batches until nothing is left; decisions already made are not
 * revisited — the fields matter for simulations, reprocessing and the badge.
 */
export const BACKFILL_BATCH = 500;

export async function backfillSenderAuth(batch = BACKFILL_BATCH): Promise<{ filled: number; withVerdict: number }> {
  const rows = await prisma.email.findMany({
    where: { senderAuthCaptured: false, source: { isNot: null } },
    select: { id: true, fromAddress: true, source: { select: { source: true } } },
    take: batch,
  });
  let withVerdict = 0;
  for (const row of rows) {
    if (!row.source) continue;
    const auth = senderAuthFromRawSource(row.source.source, row.fromAddress);
    if (auth) withVerdict += 1;
    // Guarded on senderAuthCaptured so a concurrent live ingest/reparse is never overwritten.
    await prisma.email.updateMany({
      where: { id: row.id, senderAuthCaptured: false },
      data: { senderAuthCaptured: true, senderAuth: auth ? (auth as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
  }
  return { filled: rows.length, withVerdict };
}
