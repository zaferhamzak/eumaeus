"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOrganizationsList } from "@/hooks/useOrganizations";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { formatRelativeTime } from "@/lib/format";
import { useMe } from "@/hooks/useAuth";
import { useT } from "@/lib/i18n/I18nProvider";

export default function OrganizationsPage() {
  const t = useT();
  const organizations = useOrganizationsList();
  const rows = organizations.data?.data ?? [];
  const me = useMe();
  // Organization CREATION has no target Membership to check against yet —
  // superAdmin-only on the backend (requireSuperAdmin, not the per-Membership
  // permission catalog), so this checks isSuperAdmin directly rather than
  // useHasPermission (which reads a Membership that wouldn't apply here).
  const canCreate = me.data?.user.isSuperAdmin ?? false;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("organizations.title")}</h1>
          <p className="text-sm text-foreground-muted">{t("organizations.subtitle")}</p>
        </div>
        {canCreate ? (
          <Link href="/organizations/new">
            <Button variant="primary">{t("organizations.newOrganization")}</Button>
          </Link>
        ) : null}
      </header>

      <Suspense>
        <DeletedBanner />
      </Suspense>

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {organizations.isPending ? (
          <TableSkeleton />
        ) : organizations.isError ? (
          <ErrorState error={organizations.error} onRetry={() => organizations.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("organizations.emptyTitle")}
            description={t("organizations.emptyDescription")}
            action={
              canCreate ? (
                <Link href="/organizations/new">
                  <Button variant="secondary">{t("organizations.newOrganization")}</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th className="text-[10px]">{t("organizations.colName")}</Th>
                <Th className="text-[10px]">{t("organizations.colSlug")}</Th>
                <Th className="w-[100px] text-[10px]">{t("organizations.colStatus")}</Th>
                <Th className="w-[100px] text-[10px]">{t("organizations.colCreated")}</Th>
                <Th className="w-[10px]" aria-label={t("organizations.open")} />
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((org) => (
                <Tr key={org.id} className="group cursor-pointer">
                  <Td className="max-w-0">
                    <Link href={`/organizations/${org.id}`} className="block truncate text-sm font-medium text-foreground group-hover:text-accent group-hover:underline">
                      {org.name}
                    </Link>
                  </Td>
                  <Td className="truncate font-mono text-[10.5px] text-foreground-muted">{org.slug ?? "—"}</Td>
                  <Td>
                    <Badge tone={org.status === "active" ? "success" : "neutral"} variant="dot">
                      {org.status === "active" ? t("organizations.statusActive") : t("organizations.statusDisabled")}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[10.5px] text-foreground-muted">{formatRelativeTime(org.createdAt)}</Td>
                  <Td>
                    <Link href={`/organizations/${org.id}`} aria-label={t("organizations.openNamed", { name: org.name })} className="text-foreground-subtle group-hover:text-accent">
                      →
                    </Link>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

/** After a permanent deletion the organization page sends the browser here with ?deleted=<name>. */
function DeletedBanner() {
  const t = useT();
  const name = useSearchParams().get("deleted");
  if (!name) return null;
  return (
    <p className="border border-status-success-fg/40 bg-status-success-bg px-3 py-2 text-sm text-status-success-fg" role="status">
      {t("organizations.deletedBanner", { name })}
    </p>
  );
}
