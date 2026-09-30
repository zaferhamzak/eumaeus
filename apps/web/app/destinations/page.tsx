"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useDestinationsList,
  useCreateDestination,
} from "@/hooks/useDestinations";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ApiRequestError } from "@/lib/api/client";
import type { CreateDestinationInput } from "@/lib/api/destinations";
import { useHasPermission } from "@/hooks/useAuth";
import {
  CHANNEL_TYPE_LABELS,
  ChannelFields,
  readChannelConfig,
  type ChannelType,
} from "@/components/destinations/ChannelForm";
import { ForwardRecipientsCard } from "@/components/destinations/ForwardRecipientsCard";
import { useT } from "@/lib/i18n/I18nProvider";

type ChannelTypeChoice = "none" | ChannelType;

/**
 * The backend has always accepted an optional `channels` array at creation
 * time (destinationService.ts's createDestination loops it into
 * createDestinationChannel) — no separate API route, just this form. At most
 * one channel at creation; more can be added, edited, or disabled afterwards
 * from the destination's detail page. The channel inputs are the same
 * ChannelFields the detail page uses.
 */
function CreateDestinationModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateDestination();
  const [channelType, setChannelType] = useState<ChannelTypeChoice>("none");
  const t = useT();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("destinations.newDestination")}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get("name"));
          const description =
            String(form.get("description") || "") || undefined;
          const channels: CreateDestinationInput["channels"] =
            channelType === "none"
              ? undefined
              : [
                  {
                    type: channelType,
                    config: readChannelConfig(channelType, form),
                  },
                ];
          create.mutate(
            { name, description, channels },
            { onSuccess: onClose },
          );
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("destinations.fieldName")}
          </span>
          <input
            name="name"
            type="text"
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("destinations.descriptionOptional")}
          </span>
          <input
            name="description"
            type="text"
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("destinations.fieldChannel")}
          </span>
          <select
            value={channelType}
            onChange={(e) =>
              setChannelType(e.target.value as ChannelTypeChoice)
            }
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          >
            <option value="none">{t("destinations.noChannelYet")}</option>
            {(Object.keys(CHANNEL_TYPE_LABELS) as ChannelType[]).map((ct) => (
              <option key={ct} value={ct}>
                {t(CHANNEL_TYPE_LABELS[ct])}
              </option>
            ))}
          </select>
        </label>

        {channelType !== "none" ? (
          <ChannelFields key={channelType} type={channelType} />
        ) : null}

        {create.isError ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {create.error instanceof ApiRequestError
              ? create.error.message
              : t("destinations.createFailed")}
          </p>
        ) : null}
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t("destinations.create")}
        </Button>
      </form>
    </Modal>
  );
}

export default function DestinationsPage() {
  const destinations = useDestinationsList();
  const [createOpen, setCreateOpen] = useState(false);
  const rows = destinations.data?.data ?? [];
  const canWrite = useHasPermission("destinations:write");
  const t = useT();

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {t("destinations.title")}
          </h1>
          <p className="text-sm text-foreground-muted">
            {t("destinations.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            {t("destinations.newDestination")}
          </Button>
        ) : null}
      </header>

      {rows.length > 0 ? (
        <div className="flex items-center border border-border bg-surface-raised px-2 py-1.5 rounded-lg">
          <span className="ml-auto font-mono text-[10px] text-foreground-subtle">
            {t("destinations.loadedCount", { count: rows.length })}
          </span>
        </div>
      ) : null}

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {destinations.isPending ? (
          <TableSkeleton />
        ) : destinations.isError ? (
          <ErrorState
            error={destinations.error}
            onRetry={() => destinations.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("destinations.emptyTitle")}
            description={t("destinations.emptyDescription")}
            action={
              canWrite ? (
                <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                  {t("destinations.newDestination")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th className="text-[10px]">{t("destinations.fieldName")}</Th>
                <Th className="text-[10px]">{t("destinations.channels")}</Th>
                <Th className="w-[10px]" aria-label={t("destinations.open")} />
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((dest) => (
                <Tr key={dest.id} className="group cursor-pointer">
                  <Td className="max-w-0">
                    <Link
                      href={`/destinations/${dest.id}`}
                      className="block truncate text-sm font-medium text-foreground group-hover:text-accent group-hover:underline"
                    >
                      {dest.name}
                    </Link>
                    {dest.description ? (
                      <p className="truncate text-xs text-foreground-muted">
                        {dest.description}
                      </p>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {dest.channels.length === 0 ? (
                        <span className="text-xs text-foreground-subtle">
                          {t("destinations.noChannels")}
                        </span>
                      ) : (
                        dest.channels.map((ch) => (
                          <Badge
                            key={ch.id}
                            tone={ch.enabled ? "success" : "neutral"}
                            variant="dot"
                          >
                            <span className="font-mono">{ch.type}</span>
                          </Badge>
                        ))
                      )}
                    </div>
                  </Td>
                  <Td>
                    <Link
                      href={`/destinations/${dest.id}`}
                      aria-label={t("destinations.openDestination", {
                        name: dest.name,
                      })}
                      className="text-foreground-subtle group-hover:text-accent"
                    >
                      →
                    </Link>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>

      <ForwardRecipientsCard />

      <CreateDestinationModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
