"use client";

import { useState } from "react";
import { useSenderList, useSenderListMutations } from "@/hooks/useSenderLists";
import { useHasPermission, useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { useDestinationsList } from "@/hooks/useDestinations";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { SimulationPanel } from "@/components/rules/SimulationPanel";
import { SuggestionsPanel } from "@/components/senderLists/SuggestionsPanel";
import { RuleSuggestionsPanel } from "@/components/senderLists/RuleSuggestionsPanel";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import type { SenderListEntryResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

function BlockDestinationSetting({ current }: { current: string | null }) {
  const t = useT();
  const organizationId = useCurrentOrganizationId() ?? "";
  const canWrite = useOrgPermissions(organizationId).includes("organizations:write");
  const destinations = useDestinationsList();
  const update = useUpdateOrganization(organizationId);
  const [value, setValue] = useState(current ?? "");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block min-w-[220px] flex-1 text-sm">
        <span className={labelClass}>{t("senderLists.blockDestinationLabel")}</span>
        <select value={value} disabled={!canWrite} onChange={(e) => setValue(e.target.value)} className={inputClass}>
          <option value="">{t("senderLists.humanReview")}</option>
          {(destinations.data?.data ?? []).map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
            </option>
          ))}
          {value && !(destinations.data?.data ?? []).some((d) => d.name === value) ? <option value={value}>{value}</option> : null}
        </select>
      </label>
      {canWrite ? (
        <Button variant="secondary" disabled={value === (current ?? "")} loading={update.isPending} onClick={() => update.mutate({ blockDestinationRef: value || null })}>
          {t("common.save")}
        </Button>
      ) : (
        <p className="text-xs text-foreground-subtle">{t("senderLists.needsOrgWrite")}</p>
      )}
    </div>
  );
}

function EntryList({ title, description, entries, canWrite, onRemove }: { title: string; description: string; entries: SenderListEntryResponse[]; canWrite: boolean; onRemove: (e: SenderListEntryResponse) => void }) {
  const t = useT();
  return (
    <Card>
      <CardHeader title={t("senderLists.entryListTitle", { title, n: entries.length })} />
      <CardBody className="space-y-2">
        <p className="text-xs text-foreground-subtle">{description}</p>
        {entries.length === 0 ? (
          <p className="text-sm text-foreground-muted">{t("senderLists.noEntries")}</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] text-foreground">{e.pattern}</span>
                  <span className="block truncate text-[11px] text-foreground-subtle">
                    {e.note ? `${e.note} · ` : ""}
                    {e.createdBy ?? t("senderLists.createdBySystem")} · {formatDateTime(e.createdAt)}
                  </span>
                </span>
                {e.source === "suggestion" ? (
                  <Badge tone="info" variant="pill">
                    {t("senderLists.fromReview")}
                  </Badge>
                ) : null}
                {canWrite ? (
                  <Button variant="ghost" onClick={() => onRemove(e)}>
                    {t("senderLists.remove")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Phase 16. The allow and block lists are checked before anything else,
 * even before Jev's review signal: an allowed sender's email is left alone,
 * a blocked sender's goes to the block destination. The add form can be
 * tried on past emails first, like a rule.
 */
export default function SenderListsPage() {
  const t = useT();
  const list = useSenderList();
  const { add, remove } = useSenderListMutations();
  const canWrite = useHasPermission("rules:write") === true;
  const [kind, setKind] = useState<"allow" | "block">("block");
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [pendingRemove, setPendingRemove] = useState<SenderListEntryResponse | null>(null);

  if (list.isPending) return <LoadingState label={t("senderLists.loading")} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;

  const entries = list.data.data;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("senderLists.title")}</h1>
        <p className="text-sm text-foreground-muted">
          {t("senderLists.subtitle")}
        </p>
      </header>

      <SuggestionsPanel />

      <RuleSuggestionsPanel />

      <Card>
        <CardHeader title={t("senderLists.addSender")} />
        <CardBody className="space-y-4">
          {canWrite ? (
            <form
              className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                add.mutate(
                  { kind, pattern, ...(note.trim() ? { note: note.trim() } : {}) },
                  {
                    onSuccess: () => {
                      setPattern("");
                      setNote("");
                    },
                  },
                );
              }}
            >
              <fieldset>
                <legend className={labelClass}>{t("senderLists.list")}</legend>
                <div className="flex border border-border-strong text-sm">
                  {(["block", "allow"] as const).map((k) => (
                    <label key={k} className={`cursor-pointer px-3 py-1.5 ${kind === k ? "bg-accent text-accent-foreground" : "bg-surface-raised text-foreground"}`}>
                      <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                      {k === "block" ? t("senderLists.block") : t("senderLists.allowVip")}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-sm">
                <span className={labelClass}>{t("senderLists.addressOrDomain")}</span>
                <input value={pattern} onChange={(e) => setPattern(e.target.value)} required placeholder={t("senderLists.patternPlaceholder")} className={`${inputClass} font-mono`} />
              </label>
              <label className="block text-sm">
                <span className={labelClass}>{t("senderLists.note")}</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={inputClass} />
              </label>
              <Button type="submit" variant="primary" loading={add.isPending}>
                {t("senderLists.add")}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-foreground-muted">{t("senderLists.needsRulesWrite")}</p>
          )}
          <p className="text-[11px] text-foreground-subtle">
            {t.rich("senderLists.subdomainHelp", { code: (c) => <code className="font-mono">{c}</code> })}
          </p>
          {add.isError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {add.error instanceof ApiRequestError ? add.error.message : t("senderLists.addFailed")}
            </p>
          ) : null}
          <SimulationPanel noun="entry" getTarget={() => (pattern.trim() ? { type: "sender_entry", entry: { kind, pattern: pattern.trim() } } : { error: t("senderLists.enterPatternFirst") })} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <EntryList
          title={t("senderLists.blocked")}
          description={t("senderLists.blockedDescription")}
          entries={entries.filter((e) => e.kind === "block")}
          canWrite={canWrite}
          onRemove={setPendingRemove}
        />
        <EntryList
          title={t("senderLists.allowedVip")}
          description={t("senderLists.allowedDescription")}
          entries={entries.filter((e) => e.kind === "allow")}
          canWrite={canWrite}
          onRemove={setPendingRemove}
        />
      </div>

      <Card>
        <CardHeader title={t("senderLists.blockDestination")} />
        <CardBody>
          <BlockDestinationSetting key={list.data.blockDestinationRef ?? ""} current={list.data.blockDestinationRef} />
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t("senderLists.removeConfirmTitle")}
        description={t("senderLists.removeConfirmDescription", { pattern: pendingRemove?.pattern ?? "" })}
        confirmLabel={t("senderLists.remove")}
        loading={remove.isPending}
        onConfirm={() => {
          if (pendingRemove) remove.mutate(pendingRemove.id, { onSuccess: () => setPendingRemove(null) });
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
