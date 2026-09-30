"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDeleteOrganizationPermanently, useSetOrganizationActive } from "@/hooks/useOrganizations";
import { useMe, useOrgPermissions } from "@/hooks/useAuth";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TypeToConfirmDialog } from "@/components/ui/TypeToConfirmDialog";
import { ApiRequestError } from "@/lib/api/client";
import { getCurrentOrganizationId, setCurrentOrganizationId } from "@/lib/currentOrganization";
import { useT } from "@/lib/i18n/I18nProvider";
import type { OrganizationResponse } from "@/types/api";

/**
 * An organization's end of life, in two steps: deactivate (reversible — its
 * mailboxes stop syncing, nothing is removed), then, for the system
 * administrator, delete permanently by typing its name.
 */
export function OrganizationLifecycle({ organization }: { organization: OrganizationResponse }) {
  const t = useT();
  const router = useRouter();
  const me = useMe();
  const canDeactivate = useOrgPermissions(organization.id).includes("organizations:delete");
  const isSuperAdmin = me.data?.user.isSuperAdmin === true;
  const setActive = useSetOrganizationActive(organization.id);
  const remove = useDeleteOrganizationPermanently(organization.id);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = organization.status === "active";
  if (!canDeactivate && !isSuperAdmin) return null;

  const error = setActive.error ?? null;
  return (
    <Card className={active ? "" : "border-status-danger-fg/40"}>
      <CardHeader title={t("organizations.lifecycleTitle")} />
      <CardBody className="space-y-3">
        {active ? (
          <>
            <p className="text-sm text-foreground-muted">{t("organizations.deactivateIntro")}</p>
            {canDeactivate ? (
              <Button variant="danger" onClick={() => setConfirmDeactivate(true)}>
                {t("organizations.deactivate")}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-status-danger-fg">{t("organizations.deactivatedNotice")}</p>
            <div className="flex flex-wrap gap-2">
              {canDeactivate ? (
                <Button variant="secondary" loading={setActive.isPending} onClick={() => setActive.mutate(true)}>
                  {t("organizations.reactivate")}
                </Button>
              ) : null}
              {isSuperAdmin ? (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  {t("organizations.deletePermanently")}
                </Button>
              ) : null}
            </div>
            {isSuperAdmin ? <p className="text-xs text-foreground-subtle">{t("organizations.deletePermanentlyHint")}</p> : null}
          </>
        )}
        {error ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {error instanceof ApiRequestError ? error.message : t("common.saveFailed")}
          </p>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirmDeactivate}
        title={t("organizations.deactivateTitle", { name: organization.name })}
        description={t("organizations.deactivateDescription")}
        confirmLabel={t("organizations.deactivate")}
        loading={setActive.isPending}
        onConfirm={() => setActive.mutate(false, { onSuccess: () => setConfirmDeactivate(false) })}
        onCancel={() => setConfirmDeactivate(false)}
      />
      <TypeToConfirmDialog
        open={confirmDelete}
        title={t("organizations.deleteTitle", { name: organization.name })}
        description={t("organizations.deleteDescription")}
        expected={organization.name}
        confirmLabel={t("organizations.deletePermanently")}
        loading={remove.isPending}
        error={remove.error instanceof ApiRequestError ? remove.error.message : remove.error ? t("common.saveFailed") : null}
        onConfirm={(typed) =>
          remove.mutate(typed, {
            onSuccess: () => {
              setConfirmDelete(false);
              // Don't leave the app pointing at an organization that no longer exists.
              if (getCurrentOrganizationId() === organization.id) setCurrentOrganizationId(null);
              router.push(`/organizations?deleted=${encodeURIComponent(organization.name)}`);
            },
          })
        }
        onCancel={() => setConfirmDelete(false)}
      />
    </Card>
  );
}
