import { prisma } from "../../db/client.js";
import { readSenderAuth } from "../ingestion/senderAuth.js";

/**
 * Phase 22: condition fields that aren't stored on the email itself but
 * derived from it and its surroundings, always AS OF the moment the email
 * arrived — so a simulation over last month's mail and the live engine
 * reach the same answer for the same email.
 *
 *   email.business_hours    arrived within the organization's working hours
 *                           (unknown when no hours are set)
 *   email.is_reply          has In-Reply-To or References (unknown for mail
 *                           ingested before these headers were captured)
 *   sender.first_email      no earlier email from this address in the
 *                           organization (case-insensitive)
 *   sender.emails_last_24h  emails from this address in the 24 hours before it
 *
 * Phase 27, the receiving provider's verdict on the sender (senderAuth.ts):
 *   sender.spf / sender.dkim / sender.dmarc   "pass", "fail", "softfail", "none", …
 *   sender.authenticated    DMARC pass, or SPF/DKIM pass aligned with From
 * (unknown for mail ingested before 0.27, or when the provider left no verdict)
 *
 * "Unknown" is undefined: a condition on it never matches (conditions.ts's
 * fail-safe rule), rather than guessing. Sender history only sees what Jev
 * Mail still holds — retention and KVKK erasure shorten it.
 */
export interface DerivedFields {
  businessHours?: boolean;
  isReply?: boolean;
  firstFromSender?: boolean;
  senderLast24h?: number;
  spf?: string;
  dkim?: string;
  dmarc?: string;
  authenticated?: boolean;
}

export interface BusinessHours {
  timeZone: string;
  /** ISO weekdays, Monday = 1 … Sunday = 7. */
  days: number[];
  start: string; // "HH:MM"
  end: string; // "HH:MM"; earlier than start = overnight window
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns the problems with a business-hours setting (empty = valid). */
export function validateBusinessHours(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["businessHours must be { timeZone, days, start, end }"];
  const v = value as Partial<BusinessHours>;
  const errors: string[] = [];
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(v.timeZone) });
  } catch {
    errors.push(`Unknown time zone "${String(v.timeZone)}"`);
  }
  if (!Array.isArray(v.days) || v.days.length === 0 || v.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errors.push("days must list weekdays 1 (Monday) to 7 (Sunday)");
  if (typeof v.start !== "string" || !HHMM.test(v.start) || typeof v.end !== "string" || !HHMM.test(v.end)) errors.push('start and end must be times like "09:00"');
  else if (v.start === v.end) errors.push("start and end can't be the same time");
  return errors;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isWithinBusinessHours(at: Date, hours: BusinessHours): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const day = WEEKDAY[parts.weekday ?? ""] ?? 0;
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const start = minutes(hours.start);
  const end = minutes(hours.end);
  if (start < end) return hours.days.includes(day) && now >= start && now < end;
  // Overnight (e.g. 22:00–06:00): the evening part belongs to a listed day, the early-morning part to the day before.
  const previous = day === 1 ? 7 : day - 1;
  return (hours.days.includes(day) && now >= start) || (hours.days.includes(previous) && now < end);
}

export interface EmailForDerivation {
  id: string;
  fromAddress: string;
  receivedAt: Date;
  threadHeadersCaptured?: boolean;
  inReplyTo?: string | null;
  references?: string | null;
  senderAuth?: unknown;
}

/** The derived fields for a batch of one organization's emails (one query for the sender history). */
export async function computeDerivedFields(tenantId: string, emails: EmailForDerivation[], businessHours: unknown): Promise<Map<string, DerivedFields>> {
  const out = new Map<string, DerivedFields>();
  if (emails.length === 0) return out;
  const hours = businessHours && validateBusinessHours(businessHours).length === 0 ? (businessHours as BusinessHours) : null;

  // received_at is timestamp(3) without time zone, holding UTC — compare in UTC
  // wall-clock time so the database session's time zone never shifts it.
  const history = await prisma.$queryRaw<Array<{ id: string; last24: bigint; earlier: boolean }>>`
    SELECT x.id,
           (SELECT count(*) FROM email e
             WHERE e.tenant_id = ${tenantId} AND lower(e.from_address) = lower(x.addr)
               AND e.received_at < x.at AND e.received_at >= x.at - interval '24 hours') AS last24,
           EXISTS (SELECT 1 FROM email e
             WHERE e.tenant_id = ${tenantId} AND lower(e.from_address) = lower(x.addr) AND e.received_at < x.at) AS earlier
    FROM unnest(${emails.map((e) => e.id)}::text[], ${emails.map((e) => e.fromAddress)}::text[], ${emails.map((e) => e.receivedAt.toISOString().replace("Z", ""))}::timestamp[]) AS x(id, addr, at)`;
  const byId = new Map(history.map((h) => [h.id, h]));

  for (const email of emails) {
    const h = byId.get(email.id);
    out.set(email.id, {
      ...(hours ? { businessHours: isWithinBusinessHours(email.receivedAt, hours) } : {}),
      ...(email.threadHeadersCaptured ? { isReply: Boolean(email.inReplyTo?.trim() || email.references?.trim()) } : {}),
      ...(h ? { firstFromSender: !h.earlier, senderLast24h: Number(h.last24) } : {}),
      ...senderAuthFields(email.senderAuth),
    });
  }
  return out;
}

/** The sender.* verdict fields of a stored senderAuth value (none when unknown). */
export function senderAuthFields(value: unknown): Pick<DerivedFields, "spf" | "dkim" | "dmarc" | "authenticated"> {
  const auth = readSenderAuth(value);
  if (!auth) return {};
  return {
    ...(auth.spf ? { spf: auth.spf } : {}),
    ...(auth.dkim ? { dkim: auth.dkim } : {}),
    ...(auth.dmarc ? { dmarc: auth.dmarc } : {}),
    ...(auth.authenticated !== undefined ? { authenticated: auth.authenticated } : {}),
  };
}
