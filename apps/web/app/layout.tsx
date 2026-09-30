import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";
import { isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, type Locale } from "@/lib/i18n/locales";

export const metadata: Metadata = {
  title: "Eumaeus Control Plane",
  description: "Operational control plane for Eumaeus — every email understood, accounted for, routed, and traceable.",
};

/** Phase 21: the language is decided here, on the server — the cookie if set, otherwise the browser's Accept-Language. */
async function resolveLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full">
        <Providers locale={locale}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
