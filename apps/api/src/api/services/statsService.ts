import { prisma } from "../../db/client.js";
import { EmailState } from "../../types/email-state.js";

/**
 * Phase 8: the ONE minimal, read-only aggregate endpoint added to support the
 * frontend Overview dashboard's "current state" counts (email/action/review
 * counts by state) — real `groupBy` counts, tenant-scoped, never fabricated
 * and never derived from the Phase 7 in-memory metrics registry (which is
 * process-uptime-scoped and would under-count anything before the API's last
 * restart — wrong for "how many emails are currently awaiting review").
 * Nothing here is a new domain concept; it's a read over existing tables.
 */
export interface StatsResponse {
  emails: Record<string, number>;
  actions: Record<string, number>;
  review: Record<string, number>;
  mailboxes: Record<string, number>;
}

export async function getStats(tenantId: string): Promise<StatsResponse> {
  const [emailGroups, actionGroups, reviewGroups, mailboxGroups] = await Promise.all([
    prisma.email.groupBy({ by: ["state"], where: { tenantId }, _count: true }),
    prisma.actionExecution.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    prisma.humanReviewItem.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    prisma.mailboxConnection.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
  ]);

  const emails: Record<string, number> = Object.fromEntries(Object.values(EmailState).map((s) => [s, 0]));
  for (const row of emailGroups) emails[row.state] = row._count;

  const actions: Record<string, number> = { pending: 0, succeeded: 0, failed: 0, ambiguous: 0 };
  for (const row of actionGroups) actions[row.status] = row._count;

  const review: Record<string, number> = { open: 0, resolved: 0 };
  for (const row of reviewGroups) review[row.status] = row._count;

  const mailboxes: Record<string, number> = { active: 0, disabled: 0 };
  for (const row of mailboxGroups) mailboxes[row.status] = row._count;

  return { emails, actions, review, mailboxes };
}
