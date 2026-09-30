"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ApiRequestError } from "@/lib/api/client";
import type { ChannelInput } from "@/lib/api/destinations";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { EmailNotifyFields, readEmailNotifyConfig } from "./EmailNotifyFields";

export type ChannelType = ChannelInput["type"];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, MessageKey> = {
  archive: "destinations.channelTypeArchive",
  webhook: "destinations.channelTypeWebhook",
  forward: "destinations.channelTypeForward",
  flag: "destinations.channelTypeFlag",
  auto_reply: "destinations.channelTypeAutoReply",
  slack: "destinations.channelTypeSlack",
  teams: "destinations.channelTypeTeams",
  jira: "destinations.channelTypeJira",
  zendesk: "destinations.channelTypeZendesk",
  email_notify: "destinations.channelTypeEmailNotify",
};

const inputClass =
  "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass =
  "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";
const hintClass = "mt-1 block text-[11px] text-foreground-subtle";

type ForwardMode = "attachment" | "inline" | "redirect";
type ForwardDelivery = "each" | "digest";

export const DIGEST_INTERVALS: Array<{ minutes: number; label: MessageKey }> = [
  { minutes: 15, label: "destinations.digestInterval15m" },
  { minutes: 60, label: "destinations.digestInterval1h" },
  { minutes: 240, label: "destinations.digestInterval4h" },
  { minutes: 1440, label: "destinations.digestInterval1d" },
  { minutes: 10080, label: "destinations.digestInterval1w" },
];

const FORWARD_MODES: Array<{
  value: ForwardMode;
  title: MessageKey;
  description: MessageKey;
}> = [
  {
    value: "attachment",
    title: "destinations.forwardModeAttachmentTitle",
    description: "destinations.forwardModeAttachmentDescription",
  },
  {
    value: "inline",
    title: "destinations.forwardModeInlineTitle",
    description: "destinations.forwardModeInlineDescription",
  },
  {
    value: "redirect",
    title: "destinations.forwardModeRedirectTitle",
    description: "destinations.forwardModeRedirectDescription",
  },
];

const ZENDESK_PRIORITIES: Array<{ value: string; label: MessageKey }> = [
  { value: "low", label: "destinations.priorityLow" },
  { value: "normal", label: "destinations.priorityNormal" },
  { value: "high", label: "destinations.priorityHigh" },
  { value: "urgent", label: "destinations.priorityUrgent" },
];

const code = (c: string) => <code className="font-mono">{c}</code>;

function splitAddresses(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function listOf(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

/** Reads the fields rendered by ChannelFields back into a channel config. */
function readFlagOptions(form: FormData): Record<string, unknown> {
  const keywords = String(form.get("keywords") ?? "")
    .split(/[,\n]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    ...(form.get("markSeen") === "on" ? { markSeen: true } : {}),
    ...(form.get("flagged") === "on" ? { flagged: true } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

export function readChannelConfig(
  type: ChannelType,
  form: FormData,
): Record<string, unknown> {
  if (type === "archive")
    return {
      folder: String(form.get("folder") ?? "").trim(),
      ...readFlagOptions(form),
    };
  if (type === "flag") return readFlagOptions(form);
  if (type === "email_notify") return readEmailNotifyConfig(form);
  const text = (name: string) => String(form.get(name) ?? "").trim();
  if (type === "auto_reply") {
    return {
      body: text("body"),
      ...(text("subjectTemplate")
        ? { subjectTemplate: text("subjectTemplate") }
        : {}),
      ...(text("fromName") ? { fromName: text("fromName") } : {}),
      cooldownDays: Number(form.get("cooldownDays") ?? 7),
      maxSpamScore: Number(form.get("maxSpamScore") ?? 0.5),
    };
  }
  if (type === "slack" || type === "teams") return { url: text("url") };
  if (type === "jira")
    return {
      baseUrl: text("baseUrl"),
      projectKey: text("projectKey"),
      issueType: text("issueType") || "Task",
      accountEmail: text("accountEmail"),
      secretName: text("secretName"),
    };
  if (type === "zendesk")
    return {
      subdomain: text("subdomain"),
      accountEmail: text("accountEmail"),
      secretName: text("secretName"),
      ...(text("priority") ? { priority: text("priority") } : {}),
    };
  if (type === "webhook") {
    const secretName = String(form.get("secretName") ?? "").trim();
    return {
      url: String(form.get("url") ?? "").trim(),
      ...(secretName ? { secretName } : {}),
    };
  }
  const mode = String(form.get("mode") ?? "attachment") as ForwardMode;
  const delivery = String(form.get("delivery") ?? "each") as ForwardDelivery;
  const cc = splitAddresses(form.get("cc"));
  const bcc = splitAddresses(form.get("bcc"));
  const fromName = String(form.get("fromName") ?? "").trim();
  const subjectTemplate = String(form.get("subjectTemplate") ?? "").trim();
  return {
    mode,
    ...(delivery === "digest"
      ? {
          delivery,
          digestIntervalMinutes: Number(form.get("digestIntervalMinutes")),
        }
      : {}),
    to: splitAddresses(form.get("to")),
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(fromName ? { fromName } : {}),
    replyTo: String(form.get("replyTo") ?? "original_sender"),
    ...(mode !== "redirect" && subjectTemplate ? { subjectTemplate } : {}),
    ...(mode === "inline"
      ? { includeAttachments: form.get("includeAttachments") === "on" }
      : {}),
    ...(mode !== "redirect"
      ? { includeAnalysis: form.get("includeAnalysis") === "on" }
      : {}),
  };
}

function ForwardFields({
  initialConfig,
}: {
  initialConfig?: Record<string, unknown>;
}) {
  const [mode, setMode] = useState<ForwardMode>(
    (initialConfig?.mode as ForwardMode | undefined) ?? "attachment",
  );
  const [delivery, setDelivery] = useState<ForwardDelivery>(
    initialConfig?.delivery === "digest" ? "digest" : "each",
  );
  const initialInterval =
    typeof initialConfig?.digestIntervalMinutes === "number"
      ? initialConfig.digestIntervalMinutes
      : 60;
  const t = useT();

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className={labelClass}>{t("destinations.howToForward")}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {FORWARD_MODES.map((m) => {
            const unavailable = m.value === "redirect" && delivery === "digest";
            return (
              <label
                key={m.value}
                title={
                  unavailable ? t("destinations.digestCantRedirect") : undefined
                }
                className={`border p-2.5 text-sm ${unavailable ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${mode === m.value ? "border-accent bg-accent-soft" : "border-border-strong bg-surface-raised"}`}
              >
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <input
                    type="radio"
                    name="mode"
                    value={m.value}
                    checked={mode === m.value}
                    disabled={unavailable}
                    onChange={() => setMode(m.value)}
                    className="accent-[var(--accent)]"
                  />
                  {t(m.title)}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-foreground-subtle">
                  {t(m.description)}
                </span>
              </label>
            );
          })}
        </div>
        {mode === "redirect" ? (
          <p
            className="mt-2 border border-status-warning-fg/40 bg-status-warning-bg px-2.5 py-2 text-xs text-status-warning-fg"
            role="note"
          >
            {t("destinations.redirectWarning")}
          </p>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className={labelClass}>{t("destinations.whenToSend")}</legend>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="delivery"
              value="each"
              checked={delivery === "each"}
              onChange={() => setDelivery("each")}
              className="accent-[var(--accent)]"
            />
            {t("destinations.deliveryEach")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="delivery"
              value="digest"
              checked={delivery === "digest"}
              onChange={() => {
                setDelivery("digest");
                if (mode === "redirect") setMode("attachment");
              }}
              className="accent-[var(--accent)]"
            />
            {t("destinations.deliveryDigest")}
          </label>
          <select
            name="digestIntervalMinutes"
            defaultValue={initialInterval}
            disabled={delivery !== "digest"}
            className="rounded-md border border-border-strong bg-surface-raised px-2 py-1 text-sm disabled:opacity-50"
          >
            {DIGEST_INTERVALS.map((i) => (
              <option key={i.minutes} value={i.minutes}>
                {t(i.label)}
              </option>
            ))}
            {DIGEST_INTERVALS.some(
              (i) => i.minutes === initialInterval,
            ) ? null : (
              <option value={initialInterval}>
                {t("destinations.minutesCount", { count: initialInterval })}
              </option>
            )}
          </select>
        </div>
        {delivery === "digest" ? (
          <span className={hintClass}>
            {t("destinations.digestHint")}{" "}
            {mode === "attachment"
              ? t("destinations.digestHintAttachment")
              : t("destinations.digestHintExcerpt")}
          </span>
        ) : null}
      </fieldset>

      <label className="block text-sm">
        <span className={labelClass}>{t("destinations.fieldTo")}</span>
        <input
          name="to"
          type="text"
          required
          placeholder="marketing@company.com"
          defaultValue={listOf(initialConfig?.to)}
          className={inputClass}
        />
        <span className={hintClass}>{t("destinations.toHint")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.ccOptional")}</span>
          <input
            name="cc"
            type="text"
            defaultValue={listOf(initialConfig?.cc)}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.bccOptional")}</span>
          <input
            name="bcc"
            type="text"
            defaultValue={listOf(initialConfig?.bcc)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.senderNameOptional")}
          </span>
          <input
            name="fromName"
            type="text"
            maxLength={100}
            placeholder={t("destinations.senderNamePlaceholder")}
            defaultValue={String(initialConfig?.fromName ?? "")}
            className={inputClass}
          />
          <span className={hintClass}>
            {t("destinations.senderAddressHint")}
          </span>
        </label>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.repliesGoTo")}</span>
          <select
            name="replyTo"
            defaultValue={String(initialConfig?.replyTo ?? "original_sender")}
            className={inputClass}
          >
            <option value="original_sender">
              {t("destinations.replyToOriginalSender")}
            </option>
            <option value="none">{t("destinations.replyToSmtpSender")}</option>
          </select>
        </label>
      </div>

      {mode !== "redirect" && delivery === "each" ? (
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.fieldSubject")}</span>
          <input
            name="subjectTemplate"
            type="text"
            maxLength={200}
            placeholder="Fwd: {subject}"
            defaultValue={String(initialConfig?.subjectTemplate ?? "")}
            className={inputClass}
          />
          <span className={hintClass}>
            {t.rich("destinations.forwardSubjectHint", { code })}
          </span>
        </label>
      ) : null}

      <div className="space-y-2">
        {mode === "inline" ? (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              name="includeAttachments"
              defaultChecked={initialConfig?.includeAttachments !== false}
            />
            {t("destinations.includeAttachments")}
          </label>
        ) : null}
        {mode !== "redirect" ? (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              name="includeAnalysis"
              defaultChecked={initialConfig?.includeAnalysis !== false}
            />
            {t("destinations.includeAnalysis")}
          </label>
        ) : null}
      </div>

      <p className="text-[11px] text-foreground-subtle">
        {t("destinations.forwardFooter")}
      </p>
    </div>
  );
}

function AutoReplyFields({
  initialConfig,
}: {
  initialConfig?: Record<string, unknown>;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className={labelClass}>{t("destinations.fieldSubject")}</span>
        <input
          name="subjectTemplate"
          type="text"
          maxLength={200}
          placeholder="Re: {subject}"
          defaultValue={String(initialConfig?.subjectTemplate ?? "")}
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        <span className={labelClass}>{t("destinations.fieldMessage")}</span>
        <textarea
          name="body"
          required
          rows={5}
          maxLength={5000}
          defaultValue={String(initialConfig?.body ?? "")}
          placeholder={t("destinations.autoReplyBodyPlaceholder")}
          className={inputClass}
        />
        <span className={hintClass}>
          {t.rich("destinations.autoReplyBodyHint", { code })}
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.senderNameOptional")}
          </span>
          <input
            name="fromName"
            type="text"
            maxLength={100}
            defaultValue={String(initialConfig?.fromName ?? "")}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.cooldownLabel")}</span>
          <select
            name="cooldownDays"
            defaultValue={String(initialConfig?.cooldownDays ?? 7)}
            className={inputClass}
          >
            {[1, 3, 7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                {t("destinations.cooldownOption", { count: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.maxSpamScoreLabel")}
          </span>
          <select
            name="maxSpamScore"
            defaultValue={String(initialConfig?.maxSpamScore ?? 0.5)}
            className={inputClass}
          >
            {[0.3, 0.5, 0.7, 0.9].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {t("destinations.autoReplyFooter")}
      </p>
    </div>
  );
}

function TicketFields({
  type,
  initialConfig,
}: {
  type: "jira" | "zendesk";
  initialConfig?: Record<string, unknown>;
}) {
  const v = (k: string) => String(initialConfig?.[k] ?? "");
  const t = useT();
  return (
    <div className="space-y-3">
      {type === "jira" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm sm:col-span-2">
            <span className={labelClass}>{t("destinations.jiraSiteUrl")}</span>
            <input
              name="baseUrl"
              type="url"
              required
              placeholder="https://yourcompany.atlassian.net"
              defaultValue={v("baseUrl")}
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>{t("destinations.projectKey")}</span>
            <input
              name="projectKey"
              type="text"
              required
              placeholder="SUP"
              defaultValue={v("projectKey")}
              className={`${inputClass} font-mono uppercase`}
            />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>{t("destinations.issueType")}</span>
            <input
              name="issueType"
              type="text"
              placeholder="Task"
              defaultValue={v("issueType")}
              className={inputClass}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className={labelClass}>
              {t("destinations.zendeskSubdomain")}
            </span>
            <input
              name="subdomain"
              type="text"
              required
              placeholder="yourcompany"
              defaultValue={v("subdomain")}
              className={inputClass}
            />
            <span className={hintClass}>
              {t("destinations.zendeskSubdomainHint")}
            </span>
          </label>
          <label className="block text-sm">
            <span className={labelClass}>
              {t("destinations.priorityOptional")}
            </span>
            <select
              name="priority"
              defaultValue={v("priority")}
              className={inputClass}
            >
              <option value="">{t("destinations.zendeskDefault")}</option>
              {ZENDESK_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(p.label)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.accountEmail")}</span>
          <input
            name="accountEmail"
            type="email"
            required
            placeholder="bot@yourcompany.com"
            defaultValue={v("accountEmail")}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.apiTokenSecretName")}
          </span>
          <input
            name="secretName"
            type="text"
            required
            placeholder={type}
            defaultValue={v("secretName")}
            className={inputClass}
          />
        </label>
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {t("destinations.ticketSecretHint")}{" "}
        {type === "jira"
          ? t("destinations.jiraTokenHint")
          : t("destinations.zendeskTokenHint")}
      </p>
    </div>
  );
}

/** Read / star / keyword inputs, shared by the "flag" channel and the archive channel's "before moving" options. */
function FlagFields({
  initialConfig,
  legend,
}: {
  initialConfig?: Record<string, unknown>;
  legend: string;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-2">
      <legend className={labelClass}>{legend}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-foreground">
        <label className="flex items-center gap-2">
          <Checkbox
            name="markSeen"
            defaultChecked={initialConfig?.markSeen === true}
          />
          {t("destinations.markAsRead")}
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            name="flagged"
            defaultChecked={initialConfig?.flagged === true}
          />
          {t("destinations.starFlag")}
        </label>
      </div>
      <label className="block text-sm">
        <span className={labelClass}>{t("destinations.labelsOptional")}</span>
        <input
          name="keywords"
          type="text"
          placeholder="Pazarlama, Takip"
          defaultValue={
            Array.isArray(initialConfig?.keywords)
              ? (initialConfig.keywords as string[]).join(", ")
              : ""
          }
          className={inputClass}
        />
        <span className={hintClass}>{t("destinations.labelsHint")}</span>
      </label>
    </fieldset>
  );
}

/** The inputs for one channel type, read back with readChannelConfig. Shared by the add/edit form and the new-destination modal. */
export function ChannelFields({
  type,
  initialConfig,
  editing = false,
  destinationName,
}: {
  type: ChannelType;
  initialConfig?: Record<string, unknown>;
  editing?: boolean;
  /** For the notification channel's preview (the new-destination form reads its own name field). */
  destinationName?: string;
}) {
  const t = useT();
  if (type === "email_notify") return <EmailNotifyFields initialConfig={initialConfig} destinationName={destinationName} />;
  if (type === "archive") {
    return (
      <>
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.targetImapFolder")}
          </span>
          <input
            name="folder"
            type="text"
            required
            placeholder="Junk"
            defaultValue={String(initialConfig?.folder ?? "")}
            className={inputClass}
          />
          <span className={hintClass}>
            {t("destinations.archiveFolderHint")}
          </span>
        </label>
        <FlagFields
          initialConfig={initialConfig}
          legend={t("destinations.beforeMovingOptional")}
        />
      </>
    );
  }
  if (type === "auto_reply")
    return <AutoReplyFields initialConfig={initialConfig} />;
  if (type === "slack" || type === "teams") {
    return (
      <label className="block text-sm">
        <span className={labelClass}>
          {editing
            ? t("destinations.incomingWebhookUrlEditing")
            : t("destinations.incomingWebhookUrl")}
        </span>
        <input
          name="url"
          type="url"
          required
          placeholder={
            type === "slack"
              ? "https://hooks.slack.com/services/…"
              : "https://….webhook.office.com/…"
          }
          className={inputClass}
        />
        <span className={hintClass}>
          {type === "slack"
            ? t("destinations.slackWebhookHint")
            : t("destinations.teamsWebhookHint")}
        </span>
      </label>
    );
  }
  if (type === "jira" || type === "zendesk")
    return <TicketFields type={type} initialConfig={initialConfig} />;
  if (type === "flag") {
    return (
      <>
        <FlagFields
          initialConfig={initialConfig}
          legend={t("destinations.whatToSet")}
        />
        <p className="text-[11px] text-foreground-subtle">
          {t("destinations.flagFooter")}
        </p>
      </>
    );
  }
  if (type === "webhook") {
    return (
      <>
        <label className="block text-sm">
          <span className={labelClass}>
            {editing
              ? t("destinations.webhookUrlEditing")
              : t("destinations.webhookUrl")}
          </span>
          <input
            name="url"
            type="url"
            required
            placeholder="https://example.com/hooks/eumaeus"
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          <span className={labelClass}>
            {t("destinations.signingSecretNameOptional")}
          </span>
          <input
            name="secretName"
            type="text"
            defaultValue={String(initialConfig?.secretName ?? "")}
            className={inputClass}
          />
        </label>
      </>
    );
  }
  return <ForwardFields initialConfig={initialConfig} />;
}

/**
 * Add a channel, or edit an existing one (`fixedType` + `initialConfig`). The
 * type can't change on edit — the backend creates a new VERSION of the same
 * channel, and a different type is a different channel.
 *
 * Editing a webhook deliberately does NOT prefill the URL: the API only ever
 * returns the webhook's origin (the path/query can carry tokens, so the
 * serializer redacts them), so the full URL has to be re-entered.
 */
export function ChannelForm({
  fixedType,
  initialConfig,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  destinationName,
}: {
  destinationName?: string;
  fixedType?: ChannelType;
  initialConfig?: Record<string, unknown>;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (input: ChannelInput) => void;
  onCancel?: () => void;
}) {
  const [type, setType] = useState<ChannelType>(fixedType ?? "archive");
  const t = useT();

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          type,
          config: readChannelConfig(type, new FormData(e.currentTarget)),
        });
      }}
    >
      {fixedType ? null : (
        <label className="block text-sm">
          <span className={labelClass}>{t("destinations.channelType")}</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ChannelType)}
            className={inputClass}
          >
            {(Object.keys(CHANNEL_TYPE_LABELS) as ChannelType[]).map((ct) => (
              <option key={ct} value={ct}>
                {t(CHANNEL_TYPE_LABELS[ct])}
              </option>
            ))}
          </select>
        </label>
      )}

      <ChannelFields
        key={type}
        type={type}
        initialConfig={initialConfig}
        editing={Boolean(fixedType)}
        destinationName={destinationName}
      />

      {error ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {error instanceof ApiRequestError
            ? error.message
            : t("destinations.saveChannelFailed")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
