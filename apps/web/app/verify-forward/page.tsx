"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useVerifyForwardRecipient } from "@/hooks/useForwardRecipients";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { Logo } from "@/components/brand/Logo";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Opened from the confirmation email a new forward recipient receives. The
 * visitor is usually not a Eumaeus user, so this page is public and needs
 * nothing but the token. Confirming is an explicit click, not automatic on
 * load, so a link scanner or preview fetch can't confirm on someone's behalf.
 */
function VerifyForwardContent() {
  const t = useT();
  const token = useSearchParams().get("token") ?? "";
  const verify = useVerifyForwardRecipient();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-5 border border-border bg-surface-raised p-6 rounded-lg">
        <div className="flex items-center gap-2.5">
          <Logo size={24} className="text-foreground" />
          <span className="text-base font-semibold text-foreground">Eumaeus</span>
        </div>

        {!token ? (
          <p className="text-sm text-status-danger-fg">{t("organizations.verifyMissingToken")}</p>
        ) : verify.isSuccess ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t("organizations.verifyConfirmedTitle")}</p>
            <p className="text-sm text-foreground-muted">
              {t.rich(
                "organizations.verifyConfirmedBody",
                { mono: (c) => <span className="font-mono">{c}</span>, b: (c) => <strong>{c}</strong> },
                { address: verify.data.address, organization: verify.data.organizationName },
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-foreground-muted">{t("organizations.verifyIntro")}</p>
            {verify.isError ? (
              <p className="text-sm text-status-danger-fg" role="alert">
                {verify.error instanceof ApiRequestError ? verify.error.message : t("organizations.verifyFailed")}
              </p>
            ) : null}
            <Button variant="primary" loading={verify.isPending} onClick={() => verify.mutate(token)}>
              {t("organizations.verifyConfirm")}
            </Button>
            <p className="text-[11px] text-foreground-subtle">{t("organizations.verifyNotExpecting")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VerifyForwardPage() {
  return (
    <Suspense>
      <VerifyForwardContent />
    </Suspense>
  );
}
