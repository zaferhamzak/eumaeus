"use client";

import { use, useState } from "react";
import Link from "next/link";
import {
  useDestination,
  useDestinationSecrets,
  useDeleteDestinationSecret,
  useDisableDestination,
  useChannelMutations,
} from "@/hooks/useDestinations";
import { useHasPermission, useMembers } from "@/hooks/useAuth";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import {
  ChannelForm,
  DIGEST_INTERVALS,
  type ChannelType,
} from "@/components/destinations/ChannelForm";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { JsonViewer } from "@/components/ui/JsonViewer";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import { SetSecretForm } from "@/components/destinations/SetSecretForm";
import {
  ForwardRecipientsCard,
  RECIPIENT_STATUS,
} from "@/components/destinations/ForwardRecipientsCard";
import { useForwardRecipients } from "@/hooks/useForwardRecipients";
import { formatDateTime } from "@/lib/format";
import type {
  DestinationChannelResponse,
  DestinationResponse,
} from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

function SecretsList({ destinationId }: { destinationId: string }) {
  const secrets = useDestinationSecrets(destinationId);
  const del = useDeleteDestinationSecret(destinationId);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const t = useT();

  if (secrets.isPending) return <LoadingState />;
  if (secrets.isError)
    return (
      <ErrorState error={secrets.error} onRetry={() => secrets.refetch()} />
    );

  return (
    <div className="space-y-3">
      {secrets.data.data.length === 0 ? (
        <p className="text-sm text-foreground-subtle">
          {t("destinations.noSecrets")}
        </p>
      ) : (
        <div className="border border-border">
          {secrets.data.data.map((secret, i) => (
            <div
              key={secret.id}
              className={`flex items-center justify-between px-3 py-2 ${i < secrets.data.data.length - 1 ? "border-b border-border" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-foreground">
                  {secret.name}
                </p>
                <p className="font-mono text-[10px] text-foreground-subtle">
                  {t("destinations.secretUpdated", {
                    date: formatDateTime(secret.updatedAt),
                  })}
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => setPendingDelete(secret.name)}
              >
                {t("destinations.delete")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <SetSecretForm destinationId={destinationId} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("destinations.deleteSecretTitle")}
        description={t("destinations.deleteSecretDescription", {
          name: pendingDelete ?? "",
        })}
        confirmLabel={t("destinations.delete")}
        loading={del.isPending}
        onConfirm={() => {
          if (pendingDelete)
            del.mutate(pendingDelete, {
              onSuccess: () => setPendingDelete(null),
            });
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/**
 * A summary strip in the same visual slot as the Email/Rule "decision block",
 * but DestinationResponse has no single enabled/disabled field of its own
 * (only individual channels do — see types/api.ts) — so rather than force a
 * fake top-level status, the right-side stat is the real, honest aggregate:
 * how many of this destination's real channels are enabled.
 */
function DestinationSummary({
  destination,
}: {
  destination: DestinationResponse;
}) {
  const total = destination.channels.length;
  const enabledCount = destination.channels.filter((c) => c.enabled).length;
  const tone =
    total === 0 ? "neutral" : enabledCount === 0 ? "warning" : "success";
  const t = useT();

  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 border border-border bg-surface-raised p-3 rounded-lg">
      <div
        className="grid h-[34px] w-[34px] place-items-center border"
        style={{
          color: `var(--status-${tone}-fg)`,
          background: `var(--status-${tone}-bg)`,
          borderColor: `color-mix(in srgb, var(--status-${tone}-fg) 35%, transparent)`,
        }}
      >
        <Icon name="layers" size={17} />
      </div>
      <div className="min-w-0">
        <span className="text-[8px] font-semibold tracking-wide text-foreground-subtle uppercase">
          {t("destinations.destinationEyebrow")}
        </span>
        <h1 className="truncate text-base font-semibold text-foreground">
          {destination.name}
        </h1>
        {destination.description ? (
          <p className="truncate text-xs text-foreground-subtle">
            {destination.description}
          </p>
        ) : null}
      </div>
      <div className="text-right">
        <span className="block font-mono text-base text-foreground">
          {enabledCount}/{total}
        </span>
        <span className="block text-[8px] text-foreground-subtle">
          {t("destinations.channelsEnabled")}
        </span>
      </div>
    </div>
  );
}

const FORWARD_MODE_LABEL: Record<string, MessageKey> = {
  attachment: "destinations.forwardModeSummaryAttachment",
  inline: "destinations.forwardModeInlineTitle",
  redirect: "destinations.forwardModeSummaryRedirect",
};

/** Readable summary of a forward channel, with each recipient's confirmation state. */
function intervalLabel(t: Translate, minutes: unknown): string {
  const known = DIGEST_INTERVALS.find((i) => i.minutes === minutes);
  return known
    ? t(known.label)
    : t("destinations.minutesCount", {
        count: typeof minutes === "number" ? minutes : 60,
      });
}

function ForwardSummary({
  config,
  digest,
}: {
  config: Record<string, unknown>;
  digest?: DestinationChannelResponse["digest"];
}) {
  const recipients = useForwardRecipients();
  const t = useT();
  const statusOf = new Map(
    (recipients.data?.data ?? []).map((r) => [r.address, r.status]),
  );
  const groups: Array<[MessageKey, unknown]> = [
    ["destinations.fieldTo", config.to],
    ["destinations.fieldCc", config.cc],
    ["destinations.fieldBcc", config.bcc],
  ];
  const modeKey = FORWARD_MODE_LABEL[String(config.mode)];

  return (
    <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-foreground-subtle">
        {t("destinations.summaryMode")}
      </dt>
      <dd className="text-foreground">
        {modeKey ? t(modeKey) : String(config.mode)}
      </dd>
      <dt className="text-foreground-subtle">
        {t("destinations.summarySending")}
      </dt>
      <dd className="text-foreground">
        {config.delivery === "digest" ? (
          <>
            {t("destinations.digestEvery", {
              interval: intervalLabel(t, config.digestIntervalMinutes),
            })}
            {digest ? (
              <span className="text-foreground-subtle">
                {" "}
                · {t("destinations.digestPending", {
                  count: digest.pending,
                })} ·{" "}
                {digest.lastSentAt
                  ? t("destinations.digestLastSent", {
                      date: formatDateTime(digest.lastSentAt),
                    })
                  : t("destinations.digestNothingSent")}
              </span>
            ) : null}
          </>
        ) : (
          t("destinations.deliveryEach")
        )}
      </dd>
      {groups.map(([label, list]) =>
        Array.isArray(list) && list.length > 0 ? (
          <div key={label} className="contents">
            <dt className="text-foreground-subtle">{t(label)}</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {(list as string[]).map((address) => {
                const status =
                  RECIPIENT_STATUS[statusOf.get(address) ?? "pending"] ??
                  RECIPIENT_STATUS.pending!;
                return (
                  <span
                    key={address}
                    className="inline-flex items-center gap-1.5"
                  >
                    <span className="font-mono text-foreground">{address}</span>
                    <Badge tone={status.tone} variant="dot">
                      {t(status.label)}
                    </Badge>
                  </span>
                );
              })}
            </dd>
          </div>
        ) : null,
      )}
      {config.mode !== "redirect" && config.delivery !== "digest" ? (
        <>
          <dt className="text-foreground-subtle">
            {t("destinations.fieldSubject")}
          </dt>
          <dd className="font-mono text-foreground">
            {typeof config.subjectTemplate === "string"
              ? config.subjectTemplate
              : "Fwd: {subject}"}
          </dd>
        </>
      ) : null}
      <dt className="text-foreground-subtle">
        {t("destinations.summaryReplies")}
      </dt>
      <dd className="text-foreground">
        {config.replyTo === "none"
          ? t("destinations.repliesToSmtp")
          : t("destinations.repliesToOriginal")}
      </dd>
    </dl>
  );
}

/** Archive (move + optional flags) and flag channels in plain words. */
function ImapSummary({
  type,
  config,
}: {
  type: string;
  config: Record<string, unknown>;
}) {
  const t = useT();
  const flags = [
    config.markSeen === true ? t("destinations.flagMarkAsRead") : null,
    config.flagged === true ? t("destinations.flagStar") : null,
  ].filter(Boolean) as string[];
  const keywords = Array.isArray(config.keywords)
    ? (config.keywords as string[])
    : [];
  return (
    <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-xs">
      {type === "archive" ? (
        <>
          <dt className="text-foreground-subtle">
            {t("destinations.summaryMoveTo")}
          </dt>
          <dd className="font-mono text-foreground">
            {String(config.folder ?? "")}
          </dd>
        </>
      ) : null}
      {flags.length > 0 || keywords.length > 0 || type === "flag" ? (
        <>
          <dt className="text-foreground-subtle">
            {type === "archive"
              ? t("destinations.summaryFirst")
              : t("destinations.summarySet")}
          </dt>
          <dd className="flex flex-wrap items-center gap-1.5 text-foreground">
            {flags.join(", ")}
            {keywords.map((k) => (
              <Badge key={k} tone="info" variant="pill">
                {k}
              </Badge>
            ))}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

const PRIORITY_LABEL: Record<string, MessageKey> = {
  low: "destinations.priorityLow",
  normal: "destinations.priorityNormal",
  high: "destinations.priorityHigh",
  urgent: "destinations.priorityUrgent",
};

/** Phase 19 channels in plain words. */
function IntegrationSummary({
  type,
  config,
}: {
  type: string;
  config: Record<string, unknown>;
}) {
  const t = useT();
  const priorityKey = PRIORITY_LABEL[String(config.priority ?? "")];
  const signsInAs = t("destinations.signsInAsValue", {
    email: String(config.accountEmail ?? ""),
    secret: String(config.secretName ?? ""),
  });
  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </>
  );
  return (
    <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-xs">
      {type === "auto_reply" ? (
        <>
          {row(
            t("destinations.fieldSubject"),
            <span className="font-mono">
              {String(config.subjectTemplate ?? "Re: {subject}")}
            </span>,
          )}
          {row(
            t("destinations.fieldMessage"),
            <span className="line-clamp-3 whitespace-pre-wrap">
              {String(config.body ?? "")}
            </span>,
          )}
          {row(
            t("destinations.summaryLimits"),
            t("destinations.autoReplyLimits", {
              days: String(config.cooldownDays ?? 7),
              score: String(config.maxSpamScore ?? 0.5),
            }),
          )}
        </>
      ) : null}
      {type === "slack" || type === "teams"
        ? row(
            t("destinations.summaryWebhook"),
            <span className="font-mono">{String(config.url ?? "")}</span>,
          )
        : null}
      {type === "jira" ? (
        <>
          {row(
            t("destinations.summarySite"),
            <span className="font-mono">{String(config.baseUrl ?? "")}</span>,
          )}
          {row(
            t("destinations.summaryCreates"),
            t("destinations.jiraCreates", {
              issueType: String(config.issueType ?? "Task"),
              projectKey: String(config.projectKey ?? ""),
            }),
          )}
          {row(t("destinations.summarySignsInAs"), signsInAs)}
        </>
      ) : null}
      {type === "zendesk" ? (
        <>
          {row(
            t("destinations.summarySite"),
            <span className="font-mono">{`${String(config.subdomain ?? "")}.zendesk.com`}</span>,
          )}
          {row(
            t("destinations.summaryPriority"),
            config.priority == null
              ? t("destinations.zendeskDefault")
              : priorityKey
                ? t(priorityKey)
                : String(config.priority),
          )}
          {row(t("destinations.summarySignsInAs"), signsInAs)}
        </>
      ) : null}
    </dl>
  );
}

/** 1.2 (O): who a notification channel tells, and how often. */
function NotifySummary({ config }: { config: Record<string, unknown> }) {
  const t = useT();
  const members = useMembers(useCurrentOrganizationId() ?? "");
  const byId = new Map((members.data?.data ?? []).map((m) => [m.userId, m.email]));
  const groupLabel: Record<string, MessageKey> = {
    "reviews:resolve": "destinations.notifyGroupReviewers",
    "organizations:write": "destinations.notifyGroupAdmins",
    "emails:read": "destinations.notifyGroupEmailReaders",
  };
  const who = [
    ...(typeof config.permission === "string" ? [`${t("destinations.notifyGroup")} ${groupLabel[config.permission] ? t(groupLabel[config.permission]!) : config.permission}`] : []),
    ...(Array.isArray(config.members) ? (config.members as string[]).map((id) => byId.get(id) ?? id.slice(0, 8)) : []),
    ...(Array.isArray(config.addresses) ? (config.addresses as string[]) : []),
  ];
  const delivery = String(config.delivery ?? "each");
  const every = (m: unknown) => {
    const minutes = Number(m ?? 60);
    return minutes % 1440 === 0 ? t("destinations.notifyEveryDays", { count: minutes / 1440 }) : minutes % 60 === 0 ? t("destinations.notifyEveryHours", { count: minutes / 60 }) : t("destinations.notifyEveryMinutes", { count: minutes });
  };
  const how =
    delivery === "throttle"
      ? `${t("destinations.notifyThrottleLabel")} ${every(config.throttleMinutes)}`
      : delivery === "digest"
        ? `${t("destinations.notifyDigestLabel")}: ${every(config.digestIntervalMinutes)}`
        : t("destinations.notifyDeliveryEach");
  return (
    <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-foreground-subtle">{t("destinations.notifyWho")}</dt>
      <dd className="min-w-0 break-words text-foreground">{who.join(", ") || "—"}</dd>
      <dt className="text-foreground-subtle">{t("destinations.notifyWhen")}</dt>
      <dd className="text-foreground">{how}</dd>
      <dt className="text-foreground-subtle">{t("destinations.fieldSubject")}</dt>
      <dd className="font-mono text-foreground">{String(config.subjectTemplate ?? "{destination}: {subject}")}</dd>
    </dl>
  );
}

function ChannelRow({
  channel,
  destinationId,
  destinationName,
  canWrite,
  onDisable,
}: {
  channel: DestinationChannelResponse;
  destinationId: string;
  destinationName?: string;
  canWrite: boolean;
  onDisable: (channelId: string) => void;
}) {
  const { edit } = useChannelMutations(destinationId);
  const [editing, setEditing] = useState(false);
  const live = channel.enabled && !channel.deactivatedAt;
  const t = useT();

  return (
    <div className="border border-border p-3">
      <div className="flex items-center gap-2">
        <Badge tone={live ? "success" : "neutral"} variant="dot">
          {live ? t("destinations.enabled") : t("destinations.disabled")}
        </Badge>
        <span className="font-mono text-[11px] font-medium text-foreground">
          {channel.type}
        </span>
        <span className="font-mono text-[10px] text-foreground-subtle">
          v{channel.version}
        </span>
        {channel.deactivatedAt ? (
          <span className="text-[10px] text-foreground-subtle">
            {t("destinations.deactivatedAt", {
              date: formatDateTime(channel.deactivatedAt),
            })}
          </span>
        ) : null}
        {live && canWrite && !editing ? (
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t("destinations.edit")}
            </Button>
            <Button variant="danger" onClick={() => onDisable(channel.id)}>
              {t("destinations.disable")}
            </Button>
          </span>
        ) : null}
      </div>
      <div className="mt-2">
        {editing ? (
          <ChannelForm
            destinationName={destinationName}
            fixedType={channel.type as ChannelType}
            initialConfig={channel.config}
            submitLabel={t("destinations.saveAsNewVersion")}
            pending={edit.isPending}
            error={edit.error}
            onSubmit={(input) =>
              edit.mutate(
                { channelId: channel.id, config: input.config },
                { onSuccess: () => setEditing(false) },
              )
            }
            onCancel={() => setEditing(false)}
          />
        ) : channel.type === "forward" ? (
          <ForwardSummary config={channel.config} digest={channel.digest} />
        ) : channel.type === "archive" || channel.type === "flag" ? (
          <ImapSummary type={channel.type} config={channel.config} />
        ) : channel.type === "email_notify" ? (
          <NotifySummary config={channel.config} />
        ) : ["auto_reply", "slack", "teams", "jira", "zendesk"].includes(
            channel.type,
          ) ? (
          <IntegrationSummary type={channel.type} config={channel.config} />
        ) : (
          // Webhook URLs are already origin-redacted by the backend serializer — rendered verbatim, nothing reconstructed client-side.
          <JsonViewer
            data={channel.config}
            label={t("destinations.channelConfiguration")}
          />
        )}
      </div>
    </div>
  );
}

export default function DestinationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const destination = useDestination(id);
  const disable = useDisableDestination();
  const { add, disable: disableChannel } = useChannelMutations(id);
  const canWrite = useHasPermission("destinations:write") === true;
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [pendingChannelDisable, setPendingChannelDisable] = useState<
    string | null
  >(null);
  const [adding, setAdding] = useState(false);
  const t = useT();

  if (destination.isPending)
    return <LoadingState label={t("destinations.loadingDestination")} />;
  if (destination.isError)
    return (
      <ErrorState
        error={destination.error}
        onRetry={() => destination.refetch()}
      />
    );

  const d = destination.data;
  const liveChannels = d.channels.filter(
    (ch) => ch.enabled && !ch.deactivatedAt,
  );
  const history = d.channels.filter((ch) => !(ch.enabled && !ch.deactivatedAt));

  return (
    <div className="space-y-4">
      <Link
        href="/destinations"
        className="text-xs text-foreground-muted hover:text-accent hover:underline"
      >
        {t("destinations.backToDestinations")}
      </Link>

      <DestinationSummary destination={d} />

      <Card>
        <CardHeader
          title={t("destinations.channels")}
          action={
            canWrite ? (
              <div className="flex gap-2">
                {!adding ? (
                  <Button variant="secondary" onClick={() => setAdding(true)}>
                    {t("destinations.addChannel")}
                  </Button>
                ) : null}
                {liveChannels.length > 0 ? (
                  <Button
                    variant="danger"
                    onClick={() => setConfirmDisable(true)}
                  >
                    {t("destinations.disableAll")}
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        />
        <CardBody className="space-y-3">
          {adding ? (
            <div className="border border-accent p-3">
              <ChannelForm
                destinationName={d.name}
                submitLabel={t("destinations.addChannel")}
                pending={add.isPending}
                error={add.error}
                onSubmit={(input) =>
                  add.mutate(input, { onSuccess: () => setAdding(false) })
                }
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : null}

          {liveChannels.length === 0 && !adding ? (
            <EmptyState
              title={t("destinations.noLiveChannelsTitle")}
              description={t("destinations.noLiveChannelsDescription")}
            />
          ) : (
            <div className="space-y-2">
              {liveChannels.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  destinationId={id}
                  destinationName={d.name}
                  canWrite={canWrite}
                  onDisable={setPendingChannelDisable}
                />
              ))}
            </div>
          )}

          {history.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-foreground-subtle">
                {t("destinations.historySummary", { count: history.length })}
              </summary>
              <div className="mt-2 space-y-2">
                {history.map((ch) => (
                  <ChannelRow
                    key={ch.id}
                    channel={ch}
                    destinationId={id}
                    canWrite={false}
                    onDisable={() => {}}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </CardBody>
      </Card>

      {d.channels.some((ch) => ch.type === "forward") ? (
        <ForwardRecipientsCard />
      ) : null}

      <Card>
        <CardHeader title={t("destinations.secretsTitle")} />
        <CardBody>
          <SecretsList destinationId={id} />
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmDisable}
        title={t("destinations.disableAllTitle")}
        description={t("destinations.disableAllDescription")}
        confirmLabel={t("destinations.disable")}
        loading={disable.isPending}
        onConfirm={() =>
          disable.mutate(id, { onSuccess: () => setConfirmDisable(false) })
        }
        onCancel={() => setConfirmDisable(false)}
      />

      <ConfirmDialog
        open={pendingChannelDisable !== null}
        title={t("destinations.disableChannelTitle")}
        description={t("destinations.disableChannelDescription")}
        confirmLabel={t("destinations.disableChannel")}
        loading={disableChannel.isPending}
        onConfirm={() => {
          if (pendingChannelDisable)
            disableChannel.mutate(pendingChannelDisable, {
              onSuccess: () => setPendingChannelDisable(null),
            });
        }}
        onCancel={() => setPendingChannelDisable(null)}
      />
    </div>
  );
}
