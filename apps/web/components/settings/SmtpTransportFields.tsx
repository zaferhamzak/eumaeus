"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

/** Mirrors the backend's smtpTlsMismatch() (modules/settings/systemSettings.ts). Returns the message key of the warning. */
export function smtpTlsMismatch(port: number, secure: boolean): MessageKey | null {
  if (port === 587 && secure) return "settings.tlsMismatch587";
  if (port === 465 && !secure) return "settings.tlsMismatch465";
  return null;
}

/**
 * Host, port and TLS inputs for the Settings form (read back by name through
 * FormData). Port and TLS are controlled so a mismatch is flagged while
 * typing; saving one anyway needs the explicit confirmation box, which the
 * backend also requires.
 */
export function SmtpTransportFields({ host, port: initialPort, secure: initialSecure }: { host: string | null; port: number; secure: boolean }) {
  const t = useT();
  const [port, setPort] = useState(initialPort);
  const [secure, setSecure] = useState(initialSecure);
  const mismatch = smtpTlsMismatch(port, secure);

  return (
    <>
      <div className="grid grid-cols-[1fr_120px] gap-3">
        <label className="block text-sm">
          <span className={labelClass}>{t("settings.host")}</span>
          <input name="smtpHost" type="text" placeholder="smtp.gmail.com" defaultValue={host ?? ""} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>{t("settings.port")}</span>
          <input name="smtpPort" type="number" required value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputClass} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="smtpSecure" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
        <span className="text-foreground-muted">{t("settings.implicitTls")}</span>
      </label>
      {mismatch ? (
        <div className="space-y-2 border border-status-warning-fg/40 bg-status-warning-bg px-3 py-2 text-xs text-status-warning-fg" role="alert">
          <p>{t(mismatch)}</p>
          <label className="flex items-center gap-2">
            <Checkbox name="confirmUnusualTls" />
            {t("settings.confirmUnusualTls")}
          </label>
        </div>
      ) : null}
    </>
  );
}
