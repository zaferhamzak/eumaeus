"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMe, useLogout } from "@/hooks/useAuth";
import { useT } from "@/lib/i18n/I18nProvider";

/** Email + logout, next to OrganizationSwitcher (Topbar.tsx). Nothing renders while useMe() is loading/erroring — AppShell's own useMe()-driven redirect handles the "not logged in" case, this component just needs to not flash broken content in that brief window. */
export function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const router = useRouter();
  const t = useT();

  if (!me.data) return null;

  return (
    <div className="flex items-center gap-2 border-l border-border pl-3 text-[11px]">
      <span className="hidden text-foreground-muted sm:inline" title={me.data.user.email}>
        {me.data.user.email}
        {me.data.user.isSuperAdmin ? <span className="ml-1 text-foreground-subtle">{t("nav.admin")}</span> : null}
      </span>
      <Link href="/security" className="hidden text-foreground-muted hover:text-foreground sm:inline">
        {t("nav.security")}
      </Link>
      <button
        type="button"
        onClick={() => logout.mutate(undefined, { onSuccess: () => router.push("/login") })}
        disabled={logout.isPending}
        className="h-7 border border-border px-2 text-[10px] font-medium text-foreground-muted hover:bg-surface hover:text-foreground disabled:opacity-50"
      >
        {logout.isPending ? "…" : t("nav.logOut")}
      </button>
    </div>
  );
}
