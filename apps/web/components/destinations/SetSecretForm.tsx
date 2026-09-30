"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { useSetDestinationSecret } from "@/hooks/useDestinations";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * §19 (security-critical): the secret VALUE only ever exists as the raw
 * value of an uncontrolled <input> — it is never stored in React state
 * (never a `useState<string>` holding it), never logged, and the form is
 * reset immediately after a successful submit so the value doesn't linger in
 * the DOM either. The backend response confirms only that the secret was
 * "Configured" (a name + timestamps) — it structurally cannot contain the
 * plaintext (see lib/api/destinations.ts's own doc comment) or the encrypted
 * value, so there is nothing here that could accidentally render either.
 */
export function SetSecretForm({ destinationId }: { destinationId: string }) {
  const setSecret = useSetDestinationSecret(destinationId);
  const formRef = useRef<HTMLFormElement>(null);
  const [justConfigured, setJustConfigured] = useState<string | null>(null);
  const t = useT();

  return (
    <form
      ref={formRef}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const value = String(form.get("value") ?? "");
        if (!name || !value) return;
        setSecret.mutate(
          { name, value },
          {
            onSuccess: () => {
              setJustConfigured(name);
              formRef.current?.reset();
            },
          },
        );
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
          {t("destinations.secretName")}
        </span>
        <input
          name="name"
          type="text"
          required
          placeholder="signing_key"
          className="rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
          {t("destinations.secretValue")}
        </span>
        <input
          name="value"
          type="password"
          autoComplete="off"
          required
          className="rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
        />
      </label>
      <Button type="submit" variant="primary" loading={setSecret.isPending}>
        {t("destinations.setSecret")}
      </Button>
      {justConfigured ? (
        <span className="text-sm text-status-success-fg">
          {t("destinations.secretConfigured", { name: justConfigured })}
        </span>
      ) : null}
      {setSecret.isError ? (
        <span className="text-sm text-status-danger-fg" role="alert">
          {setSecret.error instanceof ApiRequestError
            ? setSecret.error.message
            : t("destinations.setSecretFailed")}
        </span>
      ) : null}
    </form>
  );
}
