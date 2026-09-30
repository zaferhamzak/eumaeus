"use client";

import { useT } from "@/lib/i18n/I18nProvider";

/** 1.1 (C): the mailbox has an open IDLE connection — a small green dot and "Live". */
export function LiveIndicator() {
  const t = useT();
  return (
    <span title={t("system.liveHint")} className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-status-success-fg">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-status-success-fg motion-safe:animate-pulse" />
      {t("system.live")}
    </span>
  );
}
