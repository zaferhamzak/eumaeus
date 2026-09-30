"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOAuthProviders, useStartMailboxOAuth } from "@/hooks/useMailboxes";
import { useMe } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

type Provider = "google" | "microsoft";

const LABELS: Record<Provider, MessageKey> = {
  google: "mailboxes.connectGmail",
  microsoft: "mailboxes.connectMicrosoft",
};

/**
 * Phase 17: "sign in with the provider" instead of typing an IMAP password.
 *
 * The buttons are always shown, so the option can be found before anyone
 * has set it up: a provider the super admin hasn't configured in Settings
 * opens a short explanation instead of the sign-in — with the setup steps
 * and a link to Settings for the super admin, "ask your administrator" for
 * everyone else.
 *
 * With `organizationId` (an organization's own page) the mailbox is added to
 * that organization and the sign-in comes back to its page.
 */
export function ConnectWithProvider({ organizationId, align = "end" }: { organizationId?: string; align?: "start" | "end" } = {}) {
  const providers = useOAuthProviders();
  const start = useStartMailboxOAuth();
  const me = useMe();
  const t = useT();
  const [setupFor, setSetupFor] = useState<Provider | null>(null);
  if (!providers.data) return null; // unknown yet (or failed) — don't offer a button that may not work
  const isSuperAdmin = me.data?.user.isSuperAdmin === true;

  return (
    <div className={`flex flex-col gap-1 ${align === "end" ? "items-end" : "items-start"}`}>
      <div className="flex flex-wrap gap-2">
        {(["google", "microsoft"] as const).map((provider) => {
          const ready = providers.data[provider];
          return (
            <Button
              key={provider}
              variant="secondary"
              aria-expanded={ready ? undefined : setupFor === provider}
              loading={start.isPending && start.variables?.provider === provider}
              onClick={() => (ready ? start.mutate(organizationId ? { provider, organizationId, returnTo: "organization" } : { provider }) : setSetupFor((cur) => (cur === provider ? null : provider)))}
            >
              {t(LABELS[provider])}
            </Button>
          );
        })}
      </div>
      {setupFor ? (
        <div role="note" className="max-w-md border border-border bg-surface px-3 py-2 text-left text-xs text-foreground-muted">
          <p className="font-medium text-foreground">{t(setupFor === "google" ? "mailboxes.googleNotSetUp" : "mailboxes.microsoftNotSetUp")}</p>
          {isSuperAdmin ? (
            <>
              <p className="mt-1">{t(setupFor === "google" ? "mailboxes.googleSetupSteps" : "mailboxes.microsoftSetupSteps")}</p>
              <Link href="/settings#mailbox-sign-in" className="mt-1.5 inline-block font-medium text-accent hover:underline">
                {t("mailboxes.openSignInSettings")}
              </Link>
            </>
          ) : (
            <p className="mt-1">{t("mailboxes.askAdminToSetUp")}</p>
          )}
        </div>
      ) : null}
      {start.isError ? (
        <p className="text-xs text-status-danger-fg" role="alert">
          {start.error instanceof ApiRequestError
            ? start.error.message
            : t("mailboxes.oauthStartFailed")}
        </p>
      ) : null}
    </div>
  );
}

/** The provider sends the browser back to /mailboxes with the result in the query string. */
export function OAuthResultBanner() {
  const params = useSearchParams();
  const t = useT();
  const connected = params.get("connected");
  const error = params.get("oauthError");
  if (connected) {
    return (
      <p
        className="border border-status-success-fg/40 bg-status-success-bg px-3 py-2 text-sm text-status-success-fg"
        role="status"
      >
        {params.get("reconnected")
          ? t("mailboxes.reconnectedBanner", { address: connected })
          : t("mailboxes.connectedBanner", { address: connected })}
      </p>
    );
  }
  if (error) {
    return (
      <p
        className="border border-status-danger-fg/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg"
        role="alert"
      >
        {t("mailboxes.notConnectedBanner", { error })}
      </p>
    );
  }
  return null;
}
