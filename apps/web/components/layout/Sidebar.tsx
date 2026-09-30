"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useStats } from "@/hooks/useStats";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Logo } from "@/components/brand/Logo";
import { useMe } from "@/hooks/useAuth";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/**
 * Visual pattern (dark "night pine" sidebar, section labels, Claude-orange
 * left bar and tint on the active item, orange live count badge — 0.31,
 * optional live count badge) ported from `New UI/Email Security Operations
 * Control Plane`'s sidebar. Nav items themselves are unchanged from Phase 8
 * §3 — every one of these routes is real, none are placeholders, and the one
 * count badge shown ("Human Review") is real data from useStats(), never a
 * fabricated number.
 */
const NAV_ITEMS: Array<{ href: string; label: MessageKey; icon: IconName; countKey?: "reviewOpen" }> = [
  { href: "/", label: "nav.overview", icon: "activity" },
  { href: "/emails", label: "nav.emails", icon: "inbox" },
  { href: "/review", label: "nav.review", icon: "alert", countKey: "reviewOpen" },
  { href: "/rules", label: "nav.rules", icon: "rules" },
  { href: "/rule-graphs", label: "nav.ruleGraphs", icon: "layers" },
  { href: "/sender-lists", label: "nav.senderLists", icon: "target" },
  { href: "/destinations", label: "nav.destinations", icon: "layers" },
  { href: "/organizations", label: "nav.organizations", icon: "target" },
  { href: "/mailboxes", label: "nav.mailboxes", icon: "mailbox" },
  { href: "/reports", label: "nav.reports", icon: "activity" },
  { href: "/audit", label: "nav.audit", icon: "terminal" },
  { href: "/outbound", label: "nav.outbound", icon: "send" },
  { href: "/system", label: "nav.system", icon: "settings" },
];

/** superAdmin-only, appended conditionally (not a static NAV_ITEMS entry) — the backend route itself is requireSuperAdmin-gated (api/routes/settings.ts), so this is purely "don't show a link that would 403" UX, not the actual access control. */
const SETTINGS_NAV_ITEM: { href: string; label: MessageKey; icon: IconName; countKey?: "reviewOpen" } = { href: "/settings", label: "nav.settings", icon: "sliders" };

export function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const t = useT();
  const stats = useStats();
  const me = useMe();
  const reviewOpen = stats.data?.review.open;
  const navItems = me.data?.user.isSuperAdmin ? [...NAV_ITEMS, SETTINGS_NAV_ITEM] : NAV_ITEMS;

  return (
    <nav
      aria-label={t("nav.primary")}
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex w-56 shrink-0 flex-col bg-sidebar text-sidebar-muted transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex h-[55px] items-center gap-2.5 border-b border-sidebar-border px-4 text-sidebar-foreground">
        <Logo size={26} onDark className="shrink-0" />
        <span className="text-[15px] font-semibold tracking-tight">Eumaeus</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("nav.closeNavigation")}
          className="ml-auto grid h-7 w-7 place-items-center text-sidebar-muted md:hidden"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <p className="mt-3 px-4 text-[10px] font-semibold uppercase tracking-wider text-sidebar-label">{t("nav.controlPlane")}</p>

      <ul className="flex flex-1 flex-col gap-0.5 px-2 py-1">
        {navItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const count = item.countKey === "reviewOpen" ? reviewOpen : undefined;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={onClose}
                className={cn(
                  "flex h-9 items-center gap-2.5 px-2.5 text-[12px] font-medium transition-colors",
                  active ? "bg-[rgba(217,119,87,0.16)] text-white shadow-[inset_3px_0_0_#d97757]" : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground",
                )}
              >
                <Icon name={item.icon} size={15} />
                <span className="flex-1">{t(item.label)}</span>
                {count !== undefined && count > 0 ? (
                  <em className="min-w-5 rounded-full bg-[#d97757] px-1.5 py-px text-center text-[10px] font-semibold not-italic text-[#1b0e08]">{count}</em>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
