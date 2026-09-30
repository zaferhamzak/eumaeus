"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAcceptInvite } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { Logo } from "@/components/brand/Logo";
import { useT } from "@/lib/i18n/I18nProvider";

function AcceptInvitePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const acceptInvite = useAcceptInvite();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const t = useT();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    acceptInvite.mutate({ token, password }, { onSuccess: () => router.push("/") });
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-status-danger-fg">{t("auth.inviteMissingToken")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 border border-border bg-surface-raised p-6 rounded-lg">
        <div className="flex items-center gap-2.5">
          <Logo size={24} className="text-foreground" />
          <span className="text-base font-semibold text-foreground">Eumaeus</span>
        </div>
        <p className="text-sm text-foreground-muted">{t("auth.inviteIntro")}</p>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("auth.password")}</span>
            <input
              type="password"
              required
              minLength={10}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("auth.confirmPassword")}</span>
            <input
              type="password"
              required
              minLength={10}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
            />
          </label>
          {mismatch ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {t("auth.passwordsMismatch")}
            </p>
          ) : acceptInvite.isError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {acceptInvite.error instanceof ApiRequestError ? acceptInvite.error.message : t("auth.inviteFailed")}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="w-full" loading={acceptInvite.isPending}>
            {t("auth.acceptInvite")}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInvitePageContent />
    </Suspense>
  );
}
