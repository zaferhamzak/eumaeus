"use client";

import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n/I18nProvider";
import type { ReviewSignal } from "@/types/api";

/** Real Jev `is_spam` signal, already at the exact 0.5 threshold the rule engine itself uses (see types/api.ts's ReviewSignal comment) — never an invented risk score. Shared by the Human Review list and detail pages. */
export function SignalBadge({ signal }: { signal: ReviewSignal | null }) {
  const t = useT();
  if (!signal || signal.isSuspicious === null) return <span className="text-[10px] text-foreground-subtle">{t("review.noSignal")}</span>;
  return (
    <Badge tone={signal.isSuspicious ? "danger" : "success"} variant="dot">
      {signal.isSuspicious ? t("review.signalSuspicious") : t("review.signalLikelySafe")}
    </Badge>
  );
}
