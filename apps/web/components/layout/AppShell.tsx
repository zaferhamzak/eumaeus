"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { useMe } from "@/hooks/useAuth";
import { useT } from "@/lib/i18n/I18nProvider";

// /verify-forward is opened by forward recipients, who usually aren't Eumaeus users at all.
const PUBLIC_PATHS = ["/login", "/accept-invite", "/verify-forward", "/review-action"];

/**
 * `/login` and `/accept-invite` render bare (no Sidebar/Topbar chrome) —
 * simplest fix given no route-group split exists yet; a `(app)`/`(auth)`
 * route-group restructure is the cleaner long-term alternative but isn't
 * required for this phase. Every other page additionally redirects to
 * /login client-side if useMe() 401s (belt-and-suspenders alongside
 * proxy.ts's cookie-presence check — this catches an EXPIRED-but-present
 * cookie, which proxy.ts cannot detect since it never reaches Redis).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const isPublicPath = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const me = useMe();

  useEffect(() => {
    if (!isPublicPath && me.isError) router.replace("/login");
  }, [isPublicPath, me.isError, router]);

  if (isPublicPath) return <>{children}</>;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
      ) : null}

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground"
      >
        {t("nav.skipToContent")}
      </a>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMenu={() => setMobileNavOpen(true)} />
        <main id="main-content" className="min-w-0 flex-1 overflow-x-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
