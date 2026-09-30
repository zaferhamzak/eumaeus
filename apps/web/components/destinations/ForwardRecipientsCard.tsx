"use client";

import { useState } from "react";
import {
  useForwardRecipientMutations,
  useForwardRecipients,
} from "@/hooks/useForwardRecipients";
import { useHasPermission } from "@/hooks/useAuth";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { formatDateTime } from "@/lib/format";
import type { ForwardRecipientResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

/** `label` is a message key; translate it at render time with t(). */
export const RECIPIENT_STATUS: Record<
  string,
  { tone: BadgeTone; label: MessageKey }
> = {
  verified: { tone: "success", label: "destinations.recipientConfirmed" },
  pending: { tone: "warning", label: "destinations.recipientPending" },
  revoked: { tone: "neutral", label: "destinations.recipientStopped" },
};

function detail(t: Translate, r: ForwardRecipientResponse): string {
  if (r.status === "verified" && r.verifiedAt)
    return t("destinations.confirmedAt", {
      date: formatDateTime(r.verifiedAt),
    });
  if (r.status === "pending") {
    if (!r.linkExpiresAt) return t("destinations.noConfirmationSent");
    return new Date(r.linkExpiresAt) < new Date()
      ? t("destinations.confirmationExpired")
      : t("destinations.linkValidUntil", {
          date: formatDateTime(r.linkExpiresAt),
        });
  }
  return t("destinations.nothingForwarded");
}

/**
 * Every address a forward channel sends to, with its opt-in state. Addresses
 * are added by saving a forward channel; here they can be re-sent a
 * confirmation link or stopped. Stopping takes effect on the next forward.
 */
export function ForwardRecipientsCard() {
  const recipients = useForwardRecipients();
  const { resend, revoke } = useForwardRecipientMutations();
  const canWrite = useHasPermission("destinations:write") === true;
  const [pendingRevoke, setPendingRevoke] =
    useState<ForwardRecipientResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = useT();

  const rows = recipients.data?.data ?? [];
  if (recipients.isSuccess && rows.length === 0) return null;

  return (
    <Card>
      <CardHeader title={t("destinations.forwardRecipientsTitle")} />
      <CardBody className="space-y-3">
        <p className="text-sm text-foreground-muted">
          {t("destinations.forwardRecipientsDescription")}
        </p>
        {recipients.isPending ? (
          <LoadingState />
        ) : recipients.isError ? (
          <ErrorState
            error={recipients.error}
            onRetry={() => recipients.refetch()}
          />
        ) : (
          <div className="border border-border">
            {rows.map((r, i) => {
              const known = RECIPIENT_STATUS[r.status];
              const status = known
                ? { tone: known.tone, label: t(known.label) }
                : { tone: "neutral" as const, label: r.status };
              return (
                <div
                  key={r.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${i < rows.length - 1 ? "border-b border-border" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                    {r.address}
                  </span>
                  <Badge tone={status.tone} variant="dot">
                    {status.label}
                  </Badge>
                  <span className="w-full text-[11px] text-foreground-subtle sm:w-auto">
                    {detail(t, r)}
                  </span>
                  {canWrite ? (
                    <span className="flex gap-2">
                      {r.status !== "verified" ? (
                        <Button
                          variant="secondary"
                          loading={
                            resend.isPending && resend.variables === r.id
                          }
                          onClick={() =>
                            resend.mutate(r.id, {
                              onSuccess: (res) =>
                                setNotice(
                                  res.emailSent
                                    ? t("destinations.confirmationSent", {
                                        address: r.address,
                                      })
                                    : t("destinations.smtpNotConfigured"),
                                ),
                            })
                          }
                        >
                          {r.status === "revoked"
                            ? t("destinations.askAgain")
                            : t("destinations.resendLink")}
                        </Button>
                      ) : null}
                      {r.status !== "revoked" ? (
                        <Button
                          variant="danger"
                          onClick={() => setPendingRevoke(r)}
                        >
                          {t("destinations.stop")}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {notice ? (
          <p className="text-xs text-foreground-muted">{notice}</p>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={t("destinations.stopForwardingTitle")}
        description={t("destinations.stopForwardingDescription", {
          address: pendingRevoke?.address ?? "",
        })}
        confirmLabel={t("destinations.stopForwarding")}
        loading={revoke.isPending}
        onConfirm={() => {
          if (pendingRevoke)
            revoke.mutate(pendingRevoke.id, {
              onSuccess: () => setPendingRevoke(null),
            });
        }}
        onCancel={() => setPendingRevoke(null)}
      />
    </Card>
  );
}
