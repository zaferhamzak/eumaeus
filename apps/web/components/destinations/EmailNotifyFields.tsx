"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useMembers } from "@/hooks/useAuth";
import { ApiRequestError } from "@/lib/api/client";
import { previewNotice, sendTestNotice } from "@/lib/api/destinations";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";
const hintClass = "mt-1 block text-[11px] text-foreground-subtle";

/** Permission groups offered as "everyone who…" — the useful ones, not the whole catalog. */
const PERMISSION_GROUPS: Array<{ value: string; label: MessageKey }> = [
  { value: "reviews:resolve", label: "destinations.notifyGroupReviewers" },
  { value: "organizations:write", label: "destinations.notifyGroupAdmins" },
  { value: "emails:read", label: "destinations.notifyGroupEmailReaders" },
];

const THROTTLE_OPTIONS = [15, 30, 60, 120, 240, 1440];
const DIGEST_OPTIONS = [15, 60, 240, 1440, 10080];

/** Reads EmailNotifyFields back into an "email_notify" channel config. */
export function readEmailNotifyConfig(form: FormData): Record<string, unknown> {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const members = form.getAll("notifyMember").map(String).filter(Boolean);
  const addresses = text("notifyAddresses").split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
  const delivery = text("notifyDelivery") || "each";
  return {
    ...(members.length > 0 ? { members } : {}),
    ...(text("notifyPermission") ? { permission: text("notifyPermission") } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    ...(text("subjectTemplate") ? { subjectTemplate: text("subjectTemplate") } : {}),
    ...(text("notifyIntro") ? { intro: text("notifyIntro") } : {}),
    ...(form.get("includeExcerpt") === "on" ? { includeExcerpt: true } : {}),
    ...(delivery !== "each" ? { delivery } : {}),
    ...(delivery === "throttle" ? { throttleMinutes: Number(form.get("throttleMinutes") ?? 60) } : {}),
    ...(delivery === "digest" ? { digestIntervalMinutes: Number(form.get("digestIntervalMinutes") ?? 60) } : {}),
  };
}

function minutesLabel(t: ReturnType<typeof useT>, minutes: number): string {
  if (minutes % 1440 === 0) return t("destinations.notifyEveryDays", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("destinations.notifyEveryHours", { count: minutes / 60 });
  return t("destinations.notifyEveryMinutes", { count: minutes });
}

/**
 * 1.2 (O): the "Email notification" channel — who is told, what the notice
 * says, how often. "Preview" renders it for a real email of this
 * organization; "Send me a test" mails it to the signed-in person only.
 */
export function EmailNotifyFields({ initialConfig, destinationName }: { initialConfig?: Record<string, unknown>; destinationName?: string }) {
  const t = useT();
  const orgId = useCurrentOrganizationId();
  const members = useMembers(orgId ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const [delivery, setDelivery] = useState(String(initialConfig?.delivery ?? "each"));
  const picked = new Set(Array.isArray(initialConfig?.members) ? (initialConfig.members as string[]) : []);

  const currentInput = () => {
    const form = ref.current?.closest("form");
    const data = form ? new FormData(form) : new FormData();
    const name = String(data.get("name") ?? "").trim() || destinationName || t("destinations.notifyPreviewDestination");
    return { config: readEmailNotifyConfig(data), destinationName: name };
  };
  const preview = useMutation({ mutationFn: () => previewNotice(currentInput()) });
  const test = useMutation({ mutationFn: () => sendTestNotice(currentInput()) });

  const activeMembers = (members.data?.data ?? []).filter((m) => m.status === "active");

  return (
    <div ref={ref} className="space-y-4">
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">{t("destinations.notifyWho")}</legend>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.notifyGroup")}</span>
          <select name="notifyPermission" defaultValue={String(initialConfig?.permission ?? "")} className={inputClass}>
            <option value="">{t("destinations.notifyGroupNone")}</option>
            {PERMISSION_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {t(g.label)}
              </option>
            ))}
          </select>
          <span className={hintClass}>{t("destinations.notifyGroupHint")}</span>
        </label>
        <div>
          <span className={labelClass}>{t("destinations.notifyMembers")}</span>
          {members.isPending ? (
            <p className="text-xs text-foreground-subtle">…</p>
          ) : activeMembers.length === 0 ? (
            <p className="text-xs text-foreground-subtle">{t("destinations.notifyMembersNone")}</p>
          ) : (
            <div className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
              {activeMembers.map((m) => (
                <label key={m.userId} className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                  <Checkbox name="notifyMember" value={m.userId} defaultChecked={picked.has(m.userId)} />
                  <span className="truncate">{m.email}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.notifyAddresses")}</span>
          <input name="notifyAddresses" type="text" defaultValue={Array.isArray(initialConfig?.addresses) ? (initialConfig.addresses as string[]).join(", ") : ""} placeholder="ops@example.com" className={inputClass} />
          <span className={hintClass}>{t("destinations.notifyAddressesHint")}</span>
        </label>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">{t("destinations.notifyWhat")}</legend>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.fieldSubject")}</span>
          <input name="subjectTemplate" type="text" maxLength={200} placeholder="{destination}: {subject}" defaultValue={String(initialConfig?.subjectTemplate ?? "")} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.notifyIntro")}</span>
          <textarea name="notifyIntro" rows={2} maxLength={1000} defaultValue={String(initialConfig?.intro ?? "")} placeholder={t("destinations.notifyIntroPlaceholder")} className={inputClass} />
          <span className={hintClass}>{t("destinations.notifyPlaceholdersHint")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox name="includeExcerpt" defaultChecked={initialConfig?.includeExcerpt === true} />
          {t("destinations.notifyIncludeExcerpt")}
        </label>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">{t("destinations.notifyWhen")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className={labelClass}>{t("destinations.notifyDelivery")}</span>
            <select name="notifyDelivery" value={delivery} onChange={(e) => setDelivery(e.target.value)} className={inputClass}>
              <option value="each">{t("destinations.notifyDeliveryEach")}</option>
              <option value="throttle">{t("destinations.notifyDeliveryThrottle")}</option>
              <option value="digest">{t("destinations.notifyDeliveryDigest")}</option>
            </select>
          </label>
          {delivery === "throttle" ? (
            <label className="block text-sm">
              <span className={labelClass}>{t("destinations.notifyThrottleLabel")}</span>
              <select name="throttleMinutes" defaultValue={String(initialConfig?.throttleMinutes ?? 60)} className={inputClass}>
                {THROTTLE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(t, m)}
                  </option>
                ))}
              </select>
            </label>
          ) : delivery === "digest" ? (
            <label className="block text-sm">
              <span className={labelClass}>{t("destinations.notifyDigestLabel")}</span>
              <select name="digestIntervalMinutes" defaultValue={String(initialConfig?.digestIntervalMinutes ?? 60)} className={inputClass}>
                {DIGEST_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(t, m)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <span className={hintClass}>{t(`destinations.notifyDeliveryHint_${delivery as "each" | "throttle" | "digest"}`)}</span>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" loading={preview.isPending} onClick={() => preview.mutate()}>
            {t("destinations.notifyPreview")}
          </Button>
          <Button type="button" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>
            {t("destinations.notifySendTest")}
          </Button>
          {test.data ? (
            <span role="status" className={test.data.sent ? "text-xs text-status-success-fg" : "text-xs text-status-danger-fg"}>
              {test.data.sent ? t("destinations.notifyTestSent", { to: test.data.to }) : t("destinations.notifyTestFailed", { error: test.data.error ?? "" })}
            </span>
          ) : null}
        </div>
        {preview.error || test.error ? (
          <p role="alert" className="text-sm text-status-danger-fg">
            {(preview.error ?? test.error) instanceof ApiRequestError ? ((preview.error ?? test.error) as ApiRequestError).message : t("destinations.notifyPreviewFailed")}
          </p>
        ) : null}
        {preview.data ? (
          <div className="overflow-hidden rounded-md border border-border">
            <p className="border-b border-border bg-surface px-3 py-1.5 text-xs text-foreground-muted">
              {t("destinations.notifyPreviewSubject")}: <span className="font-medium text-foreground">{preview.data.subject}</span>
            </p>
            <iframe title={t("destinations.notifyPreview")} sandbox="" srcDoc={preview.data.html} className="h-[520px] w-full bg-white" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
