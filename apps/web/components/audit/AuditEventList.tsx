"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { JsonViewer } from "@/components/ui/JsonViewer";
import { EmptyState } from "@/components/ui/EmptyState";
import { describeAuditEvent } from "@/lib/auditEventCopy";
import { formatDateTime } from "@/lib/format";
import type { AuditEventResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Shared dense audit/history rendering — used by the Email inspector's
 * History tab (components/email/EmailAuditTrail.tsx, which fetches the full
 * per-email trail via GET /api/v1/emails/:id/audit), the Human Review detail
 * page (which already has a real, backend-supplied `recentAuditEvents` array
 * embedded in ReviewDetailResponse — a distinct, bounded data source, not
 * re-fetched here), and the global Audit page (app/audit/page.tsx). Only real
 * AuditEventResponse fields are rendered.
 *
 * `showEmailLinks` is opt-in (default off): on the Email inspector and
 * Review detail, every event already belongs to the one email already on
 * screen, so a per-row "view this email" link would be redundant. The global
 * Audit page spans events across many different emails, where that same link
 * is genuinely useful — so it passes `showEmailLinks`, using the real
 * `event.emailId` field that was already part of AuditEventResponse.
 */
export function AuditEventList({
  events,
  emptyMessage,
  viewAllHref,
  showEmailLinks = false,
}: {
  events: AuditEventResponse[];
  emptyMessage: string;
  viewAllHref?: string;
  showEmailLinks?: boolean;
}) {
  const t = useT();
  if (events.length === 0) return <EmptyState title={emptyMessage} />;

  return (
    <ol className="space-y-0">
      {events.map((event, i) => {
        const { label, tone } = describeAuditEvent(event.eventType, t);
        return (
          <li key={event.id} className={`flex items-start gap-3 py-2 ${i < events.length - 1 ? "border-b border-border" : ""}`}>
            <span className="mt-0.5 w-[92px] shrink-0 font-mono text-[9.5px] text-foreground-subtle">{formatDateTime(event.createdAt)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Badge tone={tone}>{label}</Badge>
                {showEmailLinks && event.emailId ? (
                  <Link href={`/emails/${event.emailId}`} className="text-[10.5px] text-accent hover:underline">
                    {t("audit.viewEmail")}
                  </Link>
                ) : null}
              </div>
              {event.payload ? (
                <div className="mt-1.5">
                  <JsonViewer data={event.payload} label={t("audit.payload")} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
      {viewAllHref ? (
        <li className="pt-2">
          <Link href={viewAllHref} className="text-xs text-accent hover:underline">
            {t("audit.viewFullLog")}
          </Link>
        </li>
      ) : null}
    </ol>
  );
}
