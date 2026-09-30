import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";

/**
 * The Reports page (Phase 18): what came in, what Jev thought of it, where it
 * went, and how Human Review kept up, over a period. Aggregated in Postgres
 * (a report over months of mail shouldn't load every row into Node). Every
 * query is a Prisma tagged template — values are bound parameters, never
 * spliced into SQL text. Days are bucketed in the viewer's time zone.
 *
 * Everything is counted by when the email ARRIVED (not when it was
 * evaluated), so a reprocess of old mail doesn't inflate "this month".
 * Rule matches count only current decisions' evaluations would be ideal,
 * but evaluations aren't linked to decisions; a reprocessed email can count
 * twice for a rule that matched both times.
 *
 * Jev figures use each email's latest successful analysis; "spam" means
 * is_spam >= SPAM_THRESHOLD and "needs a reply" requires_response >=
 * REPLY_THRESHOLD — the same cut-offs the UI's badges use.
 */
export const SPAM_THRESHOLD = 0.8;
export const REPLY_THRESHOLD = 0.7;

export interface ReportInput {
  /** One organization, or several for the host view (every row summed). */
  tenantId: string | string[];
  days: number;
  timeZone: string;
  mailboxConnectionId?: string;
  now?: Date;
}

export interface DailyPoint {
  day: string; // YYYY-MM-DD in the requested time zone
  emails: number;
  spam: number;
  needsReply: number;
  reviewOpened: number;
  reviewResolved: number;
}

export interface Report {
  from: string;
  to: string;
  timeZone: string;
  totals: { emails: number; analyzed: number; spam: number; needsReply: number; reviewOpened: number; reviewResolved: number; reviewOpenNow: number; medianReviewHours: number | null };
  daily: DailyPoint[];
  categories: Array<{ category: string; count: number }>;
  destinations: Array<{ destinationRef: string; count: number }>;
  rules: Array<{ ruleId: string; name: string; matches: number; tenantId: string }>;
  actions: Array<{ channelType: string; succeeded: number; failed: number; ambiguous: number }>;
  /** Emails in the period with a sender verdict from the provider (0.27+), and how many of those were verified. */
  senderAuth: { checked: number; verified: number };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0));

export async function buildReport(input: ReportInput): Promise<Report> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000);
  const tz = input.timeZone;
  const tenantIds = Array.isArray(input.tenantId) ? input.tenantId : [input.tenantId];
  const inTenants = (column: Prisma.Sql) => Prisma.sql`${column} = ANY(${tenantIds}::text[])`;
  const mailboxFilter = input.mailboxConnectionId ? Prisma.sql`AND e.mailbox_connection_id = ${input.mailboxConnectionId}` : Prisma.empty;

  // The latest successful analysis per email in the period.
  const latestAnalysis = Prisma.sql`
    SELECT DISTINCT ON (a.email_id) a.email_id, a.answers
    FROM analysis_result a
    WHERE ${inTenants(Prisma.raw("a.tenant_id"))} AND a.status = 'ok'
    ORDER BY a.email_id, a.created_at DESC`;

  const [perDay, reviewDays, categories, destinations, rules, actions, reviewTotals, senderAuth] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT to_char(date_trunc('day', e.received_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
             count(*) AS emails,
             count(*) FILTER (WHERE (la.answers->'is_spam'->>'noul')::float >= ${SPAM_THRESHOLD}) AS spam,
             count(*) FILTER (WHERE (la.answers->'requires_response'->>'noul')::float >= ${REPLY_THRESHOLD}) AS needs_reply,
             count(la.email_id) AS analyzed
      FROM email e
      LEFT JOIN (${latestAnalysis}) la ON la.email_id = e.id
      WHERE ${inTenants(Prisma.raw("e.tenant_id"))} AND e.received_at >= ${since} ${mailboxFilter}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT to_char(date_trunc('day', ts AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE kind = 'opened') AS opened,
             count(*) FILTER (WHERE kind = 'resolved') AS resolved
      FROM (
        SELECT h.created_at AS ts, 'opened' AS kind FROM human_review_item h JOIN email e ON e.id = h.email_id
        WHERE ${inTenants(Prisma.raw("h.tenant_id"))} AND h.created_at >= ${since} ${mailboxFilter}
        UNION ALL
        SELECT h.resolved_at AS ts, 'resolved' AS kind FROM human_review_item h JOIN email e ON e.id = h.email_id
        WHERE ${inTenants(Prisma.raw("h.tenant_id"))} AND h.status = 'resolved' AND h.resolved_at >= ${since} ${mailboxFilter}
      ) r
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT coalesce(la.answers->'category'->>'choice', 'unknown') AS category, count(*) AS count
      FROM email e JOIN (${latestAnalysis}) la ON la.email_id = e.id
      WHERE ${inTenants(Prisma.raw("e.tenant_id"))} AND e.received_at >= ${since} ${mailboxFilter}
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Row[]>`
      SELECT CASE WHEN d.status = 'matched' THEN d.destination_ref WHEN d.status = 'sender_allowed' THEN 'left_alone' ELSE 'human_review' END AS destination_ref,
             count(*) AS count
      FROM routing_decision d JOIN email e ON e.id = d.email_id
      WHERE ${inTenants(Prisma.raw("d.tenant_id"))} AND d.superseded_at IS NULL AND e.received_at >= ${since} ${mailboxFilter}
      GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Row[]>`
      -- One row per rule, not per version (Phase 25 lineage): an edited or
      -- reverted rule's versions share a lineage and are counted together,
      -- under the newest version's name.
      SELECT coalesce(r.lineage_id, r.id) AS rule_id, (array_agg(r.name ORDER BY r.created_at DESC))[1] AS name, r.tenant_id, count(*) AS matches
      FROM rule_evaluation ev JOIN rule r ON r.id = ev.rule_id JOIN email e ON e.id = ev.email_id
      WHERE ${inTenants(Prisma.raw("ev.tenant_id"))} AND ev.matched AND e.received_at >= ${since} ${mailboxFilter}
      GROUP BY 1, 3 ORDER BY 4 DESC LIMIT 20`,
    prisma.$queryRaw<Row[]>`
      SELECT x.channel_type,
             count(*) FILTER (WHERE x.status = 'succeeded') AS succeeded,
             count(*) FILTER (WHERE x.status = 'failed') AS failed,
             count(*) FILTER (WHERE x.status = 'ambiguous') AS ambiguous
      FROM action_execution x JOIN email e ON e.id = x.email_id
      WHERE ${inTenants(Prisma.raw("x.tenant_id"))} AND x.created_at >= ${since} ${mailboxFilter}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Row[]>`
      SELECT count(*) FILTER (WHERE h.status = 'open') AS open_now,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (h.resolved_at - h.created_at)) / 3600)
               FILTER (WHERE h.status = 'resolved' AND h.resolved_at >= ${since}) AS median_hours
      FROM human_review_item h JOIN email e ON e.id = h.email_id
      WHERE ${inTenants(Prisma.raw("h.tenant_id"))} ${mailboxFilter}`,
    prisma.$queryRaw<Row[]>`
      SELECT count(*) FILTER (WHERE e.sender_auth ? 'authenticated') AS checked,
             count(*) FILTER (WHERE (e.sender_auth->>'authenticated')::boolean) AS verified
      FROM email e
      WHERE ${inTenants(Prisma.raw("e.tenant_id"))} AND e.received_at >= ${since} AND e.sender_auth IS NOT NULL ${mailboxFilter}`,
  ]);

  // Every day in the period, including days with nothing, so charts have no gaps.
  const days = new Map<string, DailyPoint>();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let t = since.getTime(); t <= now.getTime() + 1; t += 24 * 60 * 60 * 1000) {
    const day = fmt.format(new Date(t));
    days.set(day, { day, emails: 0, spam: 0, needsReply: 0, reviewOpened: 0, reviewResolved: 0 });
  }
  days.set(fmt.format(now), days.get(fmt.format(now)) ?? { day: fmt.format(now), emails: 0, spam: 0, needsReply: 0, reviewOpened: 0, reviewResolved: 0 });
  let analyzed = 0;
  for (const r of perDay) {
    const d = days.get(String(r.day));
    if (!d) continue;
    d.emails = num(r.emails);
    d.spam = num(r.spam);
    d.needsReply = num(r.needs_reply);
    analyzed += num(r.analyzed);
  }
  for (const r of reviewDays) {
    const d = days.get(String(r.day));
    if (!d) continue;
    d.reviewOpened = num(r.opened);
    d.reviewResolved = num(r.resolved);
  }
  const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const sum = (k: keyof Omit<DailyPoint, "day">) => daily.reduce((n, d) => n + d[k], 0);
  const median = reviewTotals[0]?.median_hours;

  return {
    from: since.toISOString(),
    to: now.toISOString(),
    timeZone: tz,
    totals: {
      emails: sum("emails"),
      analyzed,
      spam: sum("spam"),
      needsReply: sum("needsReply"),
      reviewOpened: sum("reviewOpened"),
      reviewResolved: sum("reviewResolved"),
      reviewOpenNow: num(reviewTotals[0]?.open_now),
      medianReviewHours: median === null || median === undefined ? null : Math.round(num(median) * 10) / 10,
    },
    daily,
    categories: categories.map((r) => ({ category: String(r.category), count: num(r.count) })),
    destinations: destinations.map((r) => ({ destinationRef: String(r.destination_ref), count: num(r.count) })),
    rules: rules.map((r) => ({ ruleId: String(r.rule_id), name: String(r.name), matches: num(r.matches), tenantId: String(r.tenant_id) })),
    actions: actions.map((r) => ({ channelType: String(r.channel_type), succeeded: num(r.succeeded), failed: num(r.failed), ambiguous: num(r.ambiguous) })),
    senderAuth: { checked: num(senderAuth[0]?.checked), verified: num(senderAuth[0]?.verified) },
  };
}

export interface OrganizationRow {
  tenantId: string;
  name: string;
  status: string;
  mailboxes: number;
  emails: number;
  spam: number;
  needsReply: number;
  reviewOpenNow: number;
  failedActions: number;
  openAlerts: number;
  lastEmailAt: string | null;
}

export interface HostReport extends Report {
  organizations: OrganizationRow[];
}

/**
 * The host view (for the person running Eumaeus, i.e. a superAdmin): the
 * same report over every organization at once, plus one row per organization
 * so a quiet, failing or backed-up one stands out. Deactivated organizations
 * are listed but left out of the totals.
 */
export async function buildHostReport(input: Omit<ReportInput, "tenantId" | "mailboxConnectionId">): Promise<HostReport> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000);
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } });
  const activeIds = tenants.filter((t) => t.status === "active").map((t) => t.id);
  const report = await buildReport({ ...input, now, tenantId: activeIds });

  const [mail, mailboxes, review, failed, alerts] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT e.tenant_id,
             count(*) FILTER (WHERE e.received_at >= ${since}) AS emails,
             count(*) FILTER (WHERE e.received_at >= ${since} AND (la.answers->'is_spam'->>'noul')::float >= ${SPAM_THRESHOLD}) AS spam,
             count(*) FILTER (WHERE e.received_at >= ${since} AND (la.answers->'requires_response'->>'noul')::float >= ${REPLY_THRESHOLD}) AS needs_reply,
             max(e.received_at) AS last_email_at
      FROM email e
      LEFT JOIN (
        SELECT DISTINCT ON (a.email_id) a.email_id, a.answers FROM analysis_result a
        WHERE a.status = 'ok' AND a.created_at >= ${since} ORDER BY a.email_id, a.created_at DESC
      ) la ON la.email_id = e.id
      GROUP BY 1`,
    prisma.mailboxConnection.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    prisma.humanReviewItem.groupBy({ by: ["tenantId"], where: { status: "open" }, _count: { _all: true } }),
    prisma.actionExecution.groupBy({ by: ["tenantId"], where: { status: { in: ["failed", "ambiguous"] }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.alert.groupBy({ by: ["tenantId"], where: { status: "open" }, _count: { _all: true } }),
  ]);
  const count = (rows: Array<{ tenantId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.tenantId, r._count._all]));
  const mailByTenant = new Map(mail.map((r) => [String(r.tenant_id), r]));
  const [mailboxCount, reviewCount, failedCount, alertCount] = [count(mailboxes), count(review), count(failed), count(alerts)];

  return {
    ...report,
    organizations: tenants.map((t) => {
      const m = mailByTenant.get(t.id);
      const last = m?.last_email_at;
      return {
        tenantId: t.id,
        name: t.name,
        status: t.status,
        mailboxes: mailboxCount.get(t.id) ?? 0,
        emails: num(m?.emails),
        spam: num(m?.spam),
        needsReply: num(m?.needs_reply),
        reviewOpenNow: reviewCount.get(t.id) ?? 0,
        failedActions: failedCount.get(t.id) ?? 0,
        openAlerts: alertCount.get(t.id) ?? 0,
        lastEmailAt: last instanceof Date ? last.toISOString() : null,
      };
    }),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
