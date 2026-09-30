"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { SenderAuthResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const tone = (verdict: string | undefined): BadgeTone =>
  verdict === "pass" ? "success" : verdict === "fail" ? "danger" : verdict === "softfail" || verdict === "permerror" || verdict === "temperror" ? "warning" : "neutral";

/**
 * Phase 27: what the receiving mail provider concluded about the sender.
 * The headline is "verified sender" / "not verified"; SPF, DKIM and DMARC
 * sit beside it for whoever wants the detail. Nothing for mail ingested
 * before the verdict was captured.
 */
export function SenderAuthBadge({ captured, auth }: { captured?: boolean; auth?: SenderAuthResponse | null }) {
  const t = useT();
  if (!captured) return null;
  if (!auth) {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-subtle">
        <Badge tone="neutral">{t("emails.authUnknown")}</Badge>
        <span>{t("emails.authNoVerdict")}</span>
      </p>
    );
  }
  const headline = auth.authenticated === true ? { tone: "success" as const, label: t("emails.authVerified") } : auth.authenticated === false ? { tone: "danger" as const, label: t("emails.authNotVerified") } : { tone: "neutral" as const, label: t("emails.authUnknown") };
  const methods = (["spf", "dkim", "dmarc"] as const).filter((m) => auth[m] !== undefined);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" title={auth.authservId ? t("emails.authCheckedBy", { server: auth.authservId }) : undefined}>
      <Badge tone={headline.tone}>{headline.label}</Badge>
      {methods.map((m) => (
        <Badge key={m} tone={tone(auth[m])} variant="dot">
          {m.toUpperCase()} {auth[m]}
        </Badge>
      ))}
      {auth.authservId ? <span className="text-foreground-subtle">{t("emails.authCheckedBy", { server: auth.authservId })}</span> : null}
    </div>
  );
}
