"use client";

import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useLogin, useLoginMfa } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { ApiRequestError, apiRequest } from "@/lib/api/client";
import { Logo } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { useT } from "@/lib/i18n/I18nProvider";

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useLogin();
  const loginMfa = useLoginMfa();
  const t = useT();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Phase 20: an SSO sign-in for an MFA account comes back here with its challenge.
  const [pendingToken, setPendingToken] = useState<string | null>(() =>
    searchParams.get("mfaToken"),
  );
  const ssoError = searchParams.get("ssoError");
  const sso = useQuery({
    queryKey: ["auth", "sso-providers"],
    queryFn: ({ signal }) =>
      apiRequest<{ google: boolean; microsoft: boolean }>(
        "/api/v1/auth/sso/providers",
        { signal },
      ),
    retry: false,
  });
  const ssoProviders = (["google", "microsoft"] as const).filter(
    (p) => sso.data?.[p],
  );
  const [code, setCode] = useState("");

  function goToNext() {
    router.push(searchParams.get("next") || "/");
  }

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: (result) => {
          if (result.mfaRequired) setPendingToken(result.pendingToken);
          else goToNext();
        },
      },
    );
  }

  function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingToken) return;
    loginMfa.mutate({ pendingToken, code }, { onSuccess: goToNext });
  }

  const error = login.error ?? loginMfa.error;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 border border-border bg-surface-raised p-6 rounded-lg">
        <div className="flex items-center gap-2.5">
          <Logo size={24} className="text-foreground" />
          <span className="text-base font-semibold text-foreground">
            Eumaeus
          </span>
          <span className="ml-auto">
            <LanguageSwitcher saveToAccount={false} />
          </span>
        </div>

        {!pendingToken ? (
          <form className="space-y-3" onSubmit={handlePasswordSubmit}>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("auth.email")}
              </span>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("auth.password")}
              </span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
              />
            </label>
            {error ? (
              <p className="text-sm text-status-danger-fg" role="alert">
                {error instanceof ApiRequestError
                  ? error.message
                  : t("auth.loginFailed")}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={login.isPending}
            >
              {t("auth.logIn")}
            </Button>
            {ssoError ? (
              <p className="text-sm text-status-danger-fg" role="alert">
                {ssoError}
              </p>
            ) : null}
            {ssoProviders.length > 0 ? (
              <div className="space-y-2 border-t border-border pt-3">
                {ssoProviders.map((p) => (
                  // A full navigation, not fetch: the server redirects to the provider.
                  <a
                    key={p}
                    href={`/api/v1/auth/sso/${p}/start`}
                    className="flex w-full items-center justify-center rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-raised"
                  >
                    {t("auth.signInWith", { provider: p === "google" ? "Google" : "Microsoft" })}
                  </a>
                ))}
              </div>
            ) : null}
          </form>
        ) : (
          <form className="space-y-3" onSubmit={handleMfaSubmit}>
            <p className="text-sm text-foreground-muted">
              {t("auth.mfaPrompt")}
            </p>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("auth.code")}
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm font-mono tracking-widest"
              />
            </label>
            {error ? (
              <p className="text-sm text-status-danger-fg" role="alert">
                {error instanceof ApiRequestError
                  ? error.message
                  : t("auth.verificationFailed")}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={loginMfa.isPending}
            >
              {t("auth.verify")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageContent />
    </Suspense>
  );
}
