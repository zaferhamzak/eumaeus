"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useTestSmtp } from "@/hooks/useSettings";
import { useT } from "@/lib/i18n/I18nProvider";

/** Sends one real email with the SAVED settings, to the address given (default: the signed-in admin). */
export function SmtpTestPanel({ defaultTo }: { defaultTo: string }) {
  const t = useT();
  const test = useTestSmtp();
  const [to, setTo] = useState(defaultTo);
  const result = test.data;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("settings.smtpTest")}</p>
      <p className="text-xs text-foreground-subtle">{t("settings.smtpTestHelp")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          // This input sits inside the Settings form: Enter must run the test, not save the settings.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (to) test.mutate(to);
            }
          }}
          aria-label={t("settings.smtpTestToAria")}
          className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
        />
        <Button type="button" variant="secondary" loading={test.isPending} disabled={!to} onClick={() => test.mutate(to)}>
          {t("settings.sendTestEmail")}
        </Button>
      </div>
      {result ? (
        result.ok ? (
          <p className="text-sm text-status-success-fg">{t("settings.testSent", { to: result.to })}</p>
        ) : (
          <div className="space-y-1 text-sm text-status-danger-fg" role="alert">
            <p>{t("settings.testCouldNotSend", { hint: result.hint ?? t("settings.testHintFallback") })}</p>
            <p className="font-mono text-[11px] break-all text-foreground-subtle">{result.message}</p>
          </div>
        )
      ) : null}
      {test.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {t("settings.testCouldNotRun")}
        </p>
      ) : null}
    </div>
  );
}
