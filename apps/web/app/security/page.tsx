"use client";

import { useRef, useState } from "react";
import {
  useMe,
  useEnrollMfa,
  useConfirmMfa,
  useDisableMfa,
  useChangePassword,
  useSessions,
  useRevokeSession,
  useRevokeOtherSessions,
} from "@/hooks/useAuth";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LoadingState } from "@/components/ui/LoadingState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Badge } from "@/components/ui/Badge";
import { ApiRequestError } from "@/lib/api/client";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

/** Enroll → shows the QR code (and the raw otpauth:// URI as a manual-entry fallback for authenticator apps that don't scan) → confirm with a code. Two real API calls, not one, on purpose — see enrollMfa()'s backend docstring: mfaEnabled only flips true after CONFIRM succeeds, so a bad scan can never lock someone out. */
function EnableMfaFlow() {
  const t = useT();
  const enroll = useEnrollMfa();
  const confirm = useConfirmMfa();
  const [code, setCode] = useState("");

  if (!enroll.data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground-muted">{t("security.mfaIntro")}</p>
        {enroll.isError ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {enroll.error instanceof ApiRequestError ? enroll.error.message : t("security.enrollFailed")}
          </p>
        ) : null}
        <Button variant="primary" loading={enroll.isPending} onClick={() => enroll.mutate()}>
          {t("security.enableMfa")}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        confirm.mutate(code);
      }}
    >
      <p className="text-sm text-foreground-muted">{t("security.scanIntro")}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI the backend generated (modules/auth/mfa.ts's buildQrCodeDataUri), not an optimizable remote image */}
      <img src={enroll.data.qrCodeDataUri} alt={t("security.qrAlt")} width={180} height={180} className="border border-border" />
      <details className="text-xs text-foreground-subtle">
        <summary className="cursor-pointer">{t("security.cantScan")}</summary>
        <p className="mt-1 font-mono break-all">{enroll.data.otpauthUri}</p>
      </details>
      <label className="block text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("security.sixDigitCode")}</span>
        <input
          type="text"
          inputMode="numeric"
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-40 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono tracking-widest"
        />
      </label>
      {confirm.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {confirm.error instanceof ApiRequestError ? confirm.error.message : t("security.incorrectCode")}
        </p>
      ) : null}
      <Button type="submit" variant="primary" loading={confirm.isPending}>
        {t("security.confirmEnable")}
      </Button>
    </form>
  );
}

function DisableMfaFlow() {
  const t = useT();
  const disable = useDisableMfa();
  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <Badge tone="success" variant="dot">
          {t("security.mfaEnabled")}
        </Badge>
        <div>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t("security.disableMfa")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        disable.mutate(code, { onSuccess: () => setConfirming(false) });
      }}
    >
      <p className="text-sm text-foreground-muted">{t("security.disableIntro")}</p>
      <label className="block text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("security.sixDigitCode")}</span>
        <input
          type="text"
          inputMode="numeric"
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-40 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono tracking-widest"
        />
      </label>
      {disable.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {disable.error instanceof ApiRequestError ? disable.error.message : t("security.incorrectCode")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={disable.isPending}>
          {t("security.confirmDisable")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Password fields are uncontrolled (FormData on submit) — same discipline as SetSecretForm.tsx: the values never enter React state and the form is reset after a successful change. */
function ChangePasswordForm() {
  const t = useT();
  const change = useChangePassword();
  const formRef = useRef<HTMLFormElement>(null);
  const [mismatch, setMismatch] = useState(false);

  return (
    <form
      ref={formRef}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const currentPassword = String(form.get("currentPassword") ?? "");
        const newPassword = String(form.get("newPassword") ?? "");
        if (newPassword !== String(form.get("confirmPassword") ?? "")) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        change.mutate({ currentPassword, newPassword }, { onSuccess: () => formRef.current?.reset() });
      }}
    >
      {(["currentPassword", "newPassword", "confirmPassword"] as const).map((name) => (
        <label key={name} className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {name === "currentPassword" ? t("security.currentPassword") : name === "newPassword" ? t("security.newPassword") : t("security.confirmPassword")}
          </span>
          <input
            name={name}
            type="password"
            required
            minLength={name === "currentPassword" ? 1 : 10}
            autoComplete={name === "currentPassword" ? "current-password" : "new-password"}
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
      ))}
      {mismatch ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {t("security.passwordMismatch")}
        </p>
      ) : change.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {change.error instanceof ApiRequestError ? change.error.message : t("security.changeFailed")}
        </p>
      ) : change.isSuccess ? (
        <p className="text-sm text-status-success-fg">
          {t("security.passwordChanged")}
          {change.data.otherSessionsRevoked > 0 ? ` ${t("security.otherSessionsSignedOut", { count: change.data.otherSessionsRevoked })}` : ""}
        </p>
      ) : null}
      <Button type="submit" variant="primary" loading={change.isPending}>
        {t("security.changePassword")}
      </Button>
    </form>
  );
}

/** A short, human-readable device label from the raw User-Agent — just enough to tell "my laptop" from "my phone" in the list. */
function describeUserAgent(ua: string | null, t: Translate): string {
  if (!ua) return t("security.unknownDevice");
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return t("security.browserOnOs", { browser, os });
  return browser ?? os ?? ua.slice(0, 60);
}

function SessionsList() {
  const t = useT();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  if (sessions.isPending) return <LoadingState label={t("security.loadingSessions")} />;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />;

  const rows = sessions.data.data;
  const others = rows.filter((s) => !s.current).length;

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border border border-border">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">
                {describeUserAgent(s.userAgent, t)}
                {s.current ? (
                  <span className="ml-2">
                    <Badge tone="success" variant="dot">
                      {t("security.thisSession")}
                    </Badge>
                  </span>
                ) : null}
              </p>
              <p className="font-mono text-[10.5px] text-foreground-subtle">
                {t("security.sessionMeta", {
                  ip: s.ip ?? t("security.unknownIp"),
                  active: formatRelativeTime(s.lastSeenAt),
                  signedIn: formatRelativeTime(s.createdAt),
                })}
              </p>
            </div>
            {!s.current ? (
              <Button variant="ghost" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                {t("security.signOut")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {others > 0 ? (
        <Button variant="danger" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
          {t("security.signOutOthers", { count: others })}
        </Button>
      ) : null}
    </div>
  );
}

export default function SecurityPage() {
  const t = useT();
  const me = useMe();

  if (me.isPending) return <LoadingState label={t("security.loadingAccount")} />;
  if (me.isError || !me.data) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;

  return (
    <div className="max-w-lg space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("security.title")}</h1>
        <p className="text-sm text-foreground-muted">{me.data.user.email}</p>
      </header>

      <Card>
        <CardHeader title={t("security.mfaTitle")} />
        <CardBody>{me.data.user.mfaEnabled ? <DisableMfaFlow /> : <EnableMfaFlow />}</CardBody>
      </Card>

      <Card>
        <CardHeader title={t("security.passwordTitle")} />
        <CardBody>
          <ChangePasswordForm />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("security.sessionsTitle")} />
        <CardBody>
          <SessionsList />
        </CardBody>
      </Card>
    </div>
  );
}
