"use client";

import { useEmailAudit } from "@/hooks/useEmails";
import { useT } from "@/lib/i18n/I18nProvider";
import { AuditEventList } from "@/components/audit/AuditEventList";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";

/**
 * The real per-email event history (the New UI reference's "Trace" tab —
 * there it was 4 hardcoded steps; here it's the actual append-only
 * AuditEvent log for this email via GET /api/v1/emails/:id/audit, which
 * existed as a working hook (useEmailAudit) with no caller before this).
 */
export function EmailAuditTrail({ emailId }: { emailId: string }) {
  const audit = useEmailAudit(emailId);
  const t = useT();

  if (audit.isPending) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (audit.isError) return <ErrorState error={audit.error} onRetry={() => audit.refetch()} />;

  return <AuditEventList events={audit.data?.data ?? []} emptyMessage={t("emails.auditEmpty")} viewAllHref={`/audit?emailId=${emailId}`} />;
}
