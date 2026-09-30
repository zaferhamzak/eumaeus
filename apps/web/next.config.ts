import type { NextConfig } from "next";

/**
 * The browser never talks to the backend API directly — it only ever calls
 * same-origin `/api/v1/*` and `/metrics` paths, which Next.js's own server
 * proxies to the real Fastify Control Plane API (§30: "the frontend must
 * never connect to Prisma/Postgres/Redis... all data must flow through the
 * existing Control Plane API", and §31: "structure frontend API access so a
 * future authenticated tenant context can be introduced without rewriting
 * every component"). Two direct benefits of proxying here instead of the
 * browser calling the API's real origin:
 *   - no CORS configuration needed on the backend at all (Phase 7 added none,
 *     and Phase 8 deliberately doesn't touch the backend to add any either);
 *   - this proxy boundary is exactly where a future auth layer (a session
 *     cookie forwarded as an Authorization header, say) would be inserted —
 *     every page/component already goes through lib/api/client.ts, which
 *     already goes through this one relative-path boundary.
 */
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

/**
 * 1.0 security headers. The CSP is strict because the app never renders
 * email HTML (components/email/EmailBody.tsx shows plain text only) and
 * loads nothing from other origins except Google Fonts. 'unsafe-inline' for
 * scripts is what Next.js's inline bootstrap needs without per-request
 * nonces. Only in production: `next dev` needs eval and websockets.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: CSP }] : []),
];

const nextConfig: NextConfig = {
  // Docker image (1.0): a self-contained server in .next/standalone.
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${API_BASE_URL}/api/v1/:path*` },
      { source: "/metrics", destination: `${API_BASE_URL}/metrics` },
    ];
  },
};

export default nextConfig;
