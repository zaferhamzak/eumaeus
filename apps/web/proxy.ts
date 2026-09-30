import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (same runtime feature,
 * new file/export name — see apps/web/AGENTS.md's warning to check the
 * installed docs before writing this kind of file, not assume an older
 * Next.js convention). Same cookie NAME as the backend's SESSION_COOKIE_NAME
 * default (apps/api/src/config/env.ts) — a genuinely shared constant would
 * need a shared package this monorepo doesn't have, so it's duplicated here
 * with an explicit pointer back to the source of truth.
 *
 * This is a UX convenience only (redirect before a flash of protected
 * content), NOT the real security boundary — it only checks that the cookie
 * is PRESENT, never whether it's valid (this runtime cannot reach Redis).
 * The actual enforcement is the backend's authContext/tenantContext plugins;
 * an expired/invalid-but-present cookie still reaches the page, and the
 * page's own useMe() query 401s and redirects client-side (see hooks/useAuth.ts).
 */
const SESSION_COOKIE_NAME = "jm_session";
const PUBLIC_PATHS = ["/login", "/accept-invite", "/verify-forward", "/review-action"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // API calls (proxied to the backend via next.config.ts's rewrites) must
  // NEVER be redirected here — a redirected fetch() follows the 307 and
  // hands the caller an HTML /login page instead of the backend's own JSON
  // 401, which apiRequest() can't parse as the expected shape. The backend's
  // own authContext/tenantContext plugins are the real enforcement for these;
  // this proxy is a page-navigation UX convenience only.
  if (pathname.startsWith("/api/")) return NextResponse.next();
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
