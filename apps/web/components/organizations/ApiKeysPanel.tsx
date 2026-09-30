"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgPermissions } from "@/hooks/useAuth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyResponse,
} from "@/lib/api/apiKeys";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const KEY_STATUS_LABELS: Record<string, MessageKey> = {
  active: "organizations.statusLabelActive",
  expired: "organizations.statusLabelExpired",
  revoked: "organizations.statusLabelRevoked",
};

const inputClass =
  "rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * Phase 20: keys for scripts and other systems. A key acts in this
 * organization only, with the permissions picked here — never more than your
 * own. The key is shown once; Eumaeus keeps only a fingerprint of it.
 */
export function ApiKeysPanel({ organizationId }: { organizationId: string }) {
  const t = useT();
  const own = useOrgPermissions(organizationId);
  const canManage = own.includes("api_keys:manage");
  const keys = useQuery({
    queryKey: ["api-keys", organizationId],
    queryFn: ({ signal }) => listApiKeys(organizationId, signal),
    enabled: canManage,
  });

  if (!canManage)
    return (
      <p className="text-sm text-foreground-muted">
        {t("organizations.apiKeysNeedManage")}
      </p>
    );

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-foreground-muted">
        {t.rich("organizations.apiKeysIntro", {
          code: (c) => <code className="font-mono text-xs">{c}</code>,
        })}
      </p>
      <CreateKeyForm
        organizationId={organizationId}
        available={own.filter((p) => p !== "api_keys:manage")}
      />
      {keys.isPending ? (
        <LoadingState label={t("organizations.loadingKeys")} />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
      ) : keys.data.data.length === 0 ? (
        <p className="text-sm text-foreground-subtle">
          {t("organizations.noKeys")}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {keys.data.data.map((k) => (
            <KeyRow key={k.id} organizationId={organizationId} apiKey={k} />
          ))}
        </ul>
      )}
    </div>
  );
}

function KeyRow({
  organizationId,
  apiKey,
}: {
  organizationId: string;
  apiKey: ApiKeyResponse;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeApiKey(organizationId, apiKey.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["api-keys", organizationId] }),
  });
  const tone =
    apiKey.status === "active"
      ? "success"
      : apiKey.status === "expired"
        ? "warning"
        : "neutral";
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <span className="font-medium">{apiKey.name}</span>
          <span className="font-mono text-foreground-subtle">
            {apiKey.prefix}_…
          </span>
          <Badge tone={tone} variant="pill">
            {KEY_STATUS_LABELS[apiKey.status]
              ? t(KEY_STATUS_LABELS[apiKey.status]!)
              : apiKey.status}
          </Badge>
        </p>
        <p className="font-mono text-[10.5px] text-foreground-muted">
          {apiKey.permissions.join(" · ")}
        </p>
        <p className="text-foreground-subtle">
          {t("organizations.keyCreatedBy", {
            user: apiKey.createdBy,
            date: formatDateTime(apiKey.createdAt),
          })}{" "}
          ·{" "}
          {apiKey.lastUsedAt
            ? t("organizations.keyLastUsed", {
                date: formatDateTime(apiKey.lastUsedAt),
              })
            : t("organizations.keyNeverUsed")}
          {apiKey.expiresAt
            ? ` · ${t("organizations.keyExpires", { date: formatDateTime(apiKey.expiresAt) })}`
            : ""}
        </p>
      </div>
      {apiKey.status !== "revoked" ? (
        <Button
          variant="danger"
          onClick={() => setConfirm(true)}
          loading={revoke.isPending}
        >
          {t("organizations.revoke")}
        </Button>
      ) : null}
      {revoke.isError ? (
        <p className="w-full text-status-danger-fg" role="alert">
          {errorText(revoke.error, t("organizations.revokeFailed"))}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={t("organizations.revokeKeyTitle", { name: apiKey.name })}
        description={t("organizations.revokeKeyDescription")}
        confirmLabel={t("organizations.revoke")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          revoke.mutate();
        }}
      />
    </li>
  );
}

function CreateKeyForm({
  organizationId,
  available,
}: {
  organizationId: string;
  available: string[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [expires, setExpires] = useState("90");
  const [shown, setShown] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      createApiKey(organizationId, {
        name: name.trim(),
        permissions,
        expiresInDays: expires ? Number(expires) : null,
      }),
    onSuccess: (result) => {
      setShown({ name: result.name, key: result.key });
      setCopied(false);
      setName("");
      setPermissions([]);
      void queryClient.invalidateQueries({
        queryKey: ["api-keys", organizationId],
      });
    },
  });

  if (shown) {
    return (
      <div
        className="space-y-2 border border-status-warning-fg/30 bg-status-warning-bg p-3"
        role="status"
      >
        <p className="text-sm font-medium text-foreground">
          {t("organizations.copyKeyNow", { name: shown.name })}
        </p>
        <code className="block break-all bg-surface px-2 py-1.5 font-mono text-xs text-foreground">
          {shown.key}
        </code>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(shown.key)
                .then(() => setCopied(true));
            }}
          >
            {copied ? t("organizations.copied") : t("organizations.copy")}
          </Button>
          <Button variant="primary" onClick={() => setShown(null)}>
            {t("organizations.done")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
        {t("organizations.newKey")}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("organizations.keyNamePlaceholder")}
          aria-label={t("organizations.keyNameAria")}
          maxLength={100}
          className={`${inputClass} min-w-56 flex-1`}
        />
        <select
          aria-label={t("organizations.expiresAria")}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          className={inputClass}
        >
          <option value="30">{t("organizations.expiresIn30")}</option>
          <option value="90">{t("organizations.expiresIn90")}</option>
          <option value="365">{t("organizations.expiresIn365")}</option>
          <option value="">{t("organizations.neverExpires")}</option>
        </select>
      </div>
      <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto border border-border p-2 sm:grid-cols-3">
        {available.map((permission) => (
          <label
            key={permission}
            className="flex items-center gap-1.5 text-[10.5px]"
          >
            <Checkbox
              checked={permissions.includes(permission)}
              onChange={(e) =>
                setPermissions(
                  e.target.checked
                    ? [...permissions, permission]
                    : permissions.filter((p) => p !== permission),
                )
              }
            />
            <span className="font-mono text-foreground-muted">
              {permission}
            </span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {t("organizations.keyPermissionsHelp")}
      </p>
      {create.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {errorText(create.error, t("organizations.createKeyFailed"))}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={!name.trim() || permissions.length === 0}
        loading={create.isPending}
      >
        {t("organizations.createKey")}
      </Button>
    </form>
  );
}
