"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { eraseSender, type SenderErasureResult } from "@/lib/api/organizations";
import type { OrganizationResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass =
  "w-28 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/** "" = keep forever. */
function toDays(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/**
 * Phase 20: how long this organization keeps email, and erasing one sender on
 * request (KVKK/GDPR). Both delete Eumaeus's own copy only — the message in
 * the mailbox is never touched.
 */
export function DataPrivacyPanel({
  organization,
}: {
  organization: OrganizationResponse;
}) {
  const t = useT();
  const permissions = useOrgPermissions(organization.id);
  const canWrite = permissions.includes("organizations:write");
  const canErase = permissions.includes("privacy:erase");
  const update = useUpdateOrganization(organization.id);
  const [bodyDays, setBodyDays] = useState(
    organization.bodyRetentionDays?.toString() ?? "",
  );
  const [emailDays, setEmailDays] = useState(
    organization.emailRetentionDays?.toString() ?? "",
  );
  const unchanged =
    toDays(bodyDays) === organization.bodyRetentionDays &&
    toDays(emailDays) === organization.emailRetentionDays;

  return (
    <div className="max-w-xl space-y-8">
      <section className="space-y-3" aria-labelledby="retention-title">
        <h3
          id="retention-title"
          className="text-sm font-semibold text-foreground"
        >
          {t("organizations.retentionTitle")}
        </h3>
        <p className="text-sm text-foreground-muted">
          {t("organizations.retentionIntro")}
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          {t("organizations.bodyRetentionBefore")}
          <input
            type="number"
            min={1}
            max={3650}
            value={bodyDays}
            disabled={!canWrite}
            onChange={(e) => setBodyDays(e.target.value)}
            className={inputClass}
            aria-label={t("organizations.bodyRetentionAria")}
          />
          {t("organizations.bodyRetentionAfter")}
        </label>
        <p className="-mt-2 text-[11px] text-foreground-subtle">
          {t("organizations.bodyRetentionHelp")}
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          {t("organizations.emailRetentionBefore")}
          <input
            type="number"
            min={1}
            max={3650}
            value={emailDays}
            disabled={!canWrite}
            onChange={(e) => setEmailDays(e.target.value)}
            className={inputClass}
            aria-label={t("organizations.emailRetentionAria")}
          />
          {t("organizations.emailRetentionAfter")}
        </label>
        <p className="-mt-2 text-[11px] text-foreground-subtle">
          {t("organizations.emailRetentionHelp")}
        </p>

        {update.isError ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {errorText(update.error, t("common.saveFailed"))}
          </p>
        ) : null}
        {update.isSuccess ? (
          <p className="text-sm text-status-success-fg">{t("common.saved")}</p>
        ) : null}
        {canWrite ? (
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={unchanged}
            onClick={() =>
              update.mutate({
                bodyRetentionDays: toDays(bodyDays),
                emailRetentionDays: toDays(emailDays),
              })
            }
          >
            {t("common.save")}
          </Button>
        ) : (
          <p className="text-xs text-foreground-subtle">
            {t("organizations.needWrite")}
          </p>
        )}
      </section>

      <SenderErasure organizationId={organization.id} canErase={canErase} />
    </div>
  );
}

function SenderErasure({
  organizationId,
  canErase,
}: {
  organizationId: string;
  canErase: boolean;
}) {
  const t = useT();
  const [address, setAddress] = useState("");
  const [preview, setPreview] = useState<SenderErasureResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const run = useMutation({
    mutationFn: ({ dryRun }: { dryRun: boolean }) =>
      eraseSender(organizationId, address, dryRun),
  });
  const done = run.data && !run.data.dryRun ? run.data : null;
  const current =
    preview && preview.address === address.trim().toLowerCase()
      ? preview
      : null;

  return (
    <section
      className="space-y-3 border-t border-border pt-6"
      aria-labelledby="erasure-title"
    >
      <h3 id="erasure-title" className="text-sm font-semibold text-foreground">
        {t("organizations.erasureTitle")}
      </h3>
      <p className="text-sm text-foreground-muted">
        {t("organizations.erasureIntro")}
      </p>
      {!canErase ? (
        <p className="text-xs text-foreground-subtle">
          {t("organizations.needErase")}
        </p>
      ) : done ? (
        <p className="text-sm text-status-success-fg" role="status">
          {t("organizations.erasedResult", {
            emails: t("organizations.emailCount", { count: done.emails }),
            address: done.address,
          })}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setConfirmText("");
              }}
              placeholder="person@example.com"
              aria-label={t("organizations.senderAddressAria")}
              className="min-w-64 flex-1 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            />
            <Button
              variant="secondary"
              disabled={!address.trim()}
              loading={run.isPending && run.variables?.dryRun}
              onClick={() =>
                run.mutate({ dryRun: true }, { onSuccess: setPreview })
              }
            >
              {t("organizations.find")}
            </Button>
          </div>
          {run.isError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {errorText(run.error, t("organizations.somethingWrong"))}
            </p>
          ) : null}
          {current ? (
            <div className="space-y-2 border border-border p-3 text-sm">
              <p className="text-foreground">
                {t("organizations.erasurePreview", {
                  emails: t("organizations.emailCount", {
                    count: current.emails,
                  }),
                  records: t("organizations.autoReplyRecordCount", {
                    count: current.autoReplyRecords,
                  }),
                  suggestions: t("organizations.suggestionCount", {
                    count: current.suggestions,
                  }),
                })}
              </p>
              {current.senderListEntries > 0 ? (
                <p className="text-xs text-status-warning-fg">
                  {t("organizations.senderListNote")}
                </p>
              ) : null}
              {current.emails + current.autoReplyRecords + current.suggestions >
              0 ? (
                <>
                  <label className="block text-xs text-foreground-muted">
                    {t("organizations.retypeToConfirm")}
                    <input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      aria-label={t("organizations.confirmAddressAria")}
                      className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
                    />
                  </label>
                  <Button
                    variant="danger"
                    disabled={
                      confirmText.trim().toLowerCase() !== current.address
                    }
                    loading={run.isPending && !run.variables?.dryRun}
                    onClick={() => run.mutate({ dryRun: false })}
                  >
                    {t("organizations.erasePermanently")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
