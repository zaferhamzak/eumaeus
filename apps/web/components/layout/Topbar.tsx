"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { useReadiness } from "@/hooks/useHealth";
import { Icon } from "@/components/ui/Icon";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { UserMenu } from "./UserMenu";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { LanguageSwitcher } from "./LanguageSwitcher";

const SECTION_LABELS: Record<string, MessageKey> = {
  "/": "nav.overview",
  "/emails": "nav.emails",
  "/review": "nav.review",
  "/rules": "nav.rules",
  "/rule-graphs": "nav.ruleGraphs",
  "/sender-lists": "nav.senderLists",
  "/settings": "nav.settings",
  "/security": "nav.security",
  "/destinations": "nav.destinations",
  "/organizations": "nav.organizations",
  "/mailboxes": "nav.mailboxes",
  "/reports": "nav.reports",
  "/audit": "nav.audit",
  "/outbound": "nav.outbound",
  "/system": "nav.system",
};

function currentSection(pathname: string): MessageKey | null {
  const match = Object.keys(SECTION_LABELS)
    .filter((href) => (href === "/" ? pathname === "/" : pathname.startsWith(href)))
    .sort((a, b) => b.length - a.length)[0];
  return match ? SECTION_LABELS[match]! : null;
}

/**
 * Breadcrumb + search + readiness indicator, visual pattern from `New UI`'s
 * topbar. Unlike the New UI reference (a static prototype), the search box
 * here performs a real navigation into the existing Emails filter (§ same
 * ban as everywhere else in this integration: no UI affordance that doesn't
 * actually do something), and the status dot reflects the real
 * `/api/v1/ready` result via useReadiness() rather than a decorative "US-EAST-1"
 * region label with no backing data.
 */
export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const readiness = useReadiness();
  const t = useT();
  const section = currentSection(pathname);
  const [query, setQuery] = useState("");

  const ok = readiness.data?.status === "ok";

  // Every background job (sync, analysis, actions, alerts) runs in the worker; without it nothing arrives and nothing warns.

  const workerDown = readiness.data?.worker?.status === "down";

  return (
    // Sticky: the organization and language switchers stay reachable while scrolling.
    <header className="sticky top-0 z-20 flex h-[55px] shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4 md:px-6">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onOpenMenu} aria-label={t("nav.openNavigation")} className="grid h-8 w-8 place-items-center border border-border md:hidden">
          <Icon name="menu" size={15} />
        </button>
        <div className="hidden items-center gap-2 text-[11.5px] sm:flex">
          <span className="text-foreground-subtle">{t("nav.operations")}</span>
          <b className="text-foreground-subtle">/</b>
          <strong className="font-semibold text-foreground">{section ? t(section) : "Eumaeus"}</strong>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <OrganizationSwitcher />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) router.push(`/emails?subject=${encodeURIComponent(query.trim())}`);
          }}
          className="hidden items-center gap-2 border border-border bg-surface px-2 sm:flex"
        >
          <Icon name="search" size={13} className="text-foreground-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("nav.searchPlaceholder")}
            aria-label={t("nav.searchPlaceholder")}
            className="h-8 w-56 bg-transparent text-[11px] text-foreground outline-none placeholder:text-foreground-subtle"
          />
        </form>

        <div
          className="flex h-8 items-center gap-1.5 border-l border-border pl-3 text-[9px] font-medium uppercase tracking-wide text-foreground-muted"
          title={workerDown ? t("nav.workerDownHint") : ok ? t("nav.apiReady") : readiness.isPending ? t("nav.apiChecking") : t("nav.apiNotReady")}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", workerDown ? "bg-status-danger-fg" : ok ? "bg-status-success-fg" : readiness.isPending ? "bg-foreground-subtle" : "bg-status-danger-fg")} />
          {workerDown ? <span className="text-status-danger-fg">{t("nav.workerDown")}</span> : ok ? t("nav.ready") : readiness.isPending ? t("nav.checking") : t("nav.notReady")}
        </div>
        <LanguageSwitcher />
        <UserMenu />
      </div>
    </header>
  );
}
