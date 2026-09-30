"use client";

import { useState } from "react";
import { useOrgPermissions, useMembers, useInviteMember, useUpdateMember, useRevokeMember } from "@/hooks/useAuth";
import { PERMISSION_CATALOG } from "@/lib/permissions";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadingState } from "@/components/ui/LoadingState";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { Checkbox } from "@/components/ui/Checkbox";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const MEMBER_STATUS_LABELS: Record<string, MessageKey> = {
  active: "organizations.statusLabelActive",
  pending: "organizations.statusLabelPending",
  revoked: "organizations.statusLabelRevoked",
};

function PermissionCheckboxes({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto border border-border p-2 sm:grid-cols-3">
      {PERMISSION_CATALOG.map((permission) => (
        <label key={permission} className="flex items-center gap-1.5 text-[10.5px]">
          <Checkbox
            checked={selected.includes(permission)}
            onChange={(e) => onChange(e.target.checked ? [...selected, permission] : selected.filter((p) => p !== permission))}
          />
          <span className="font-mono text-foreground-muted">{permission}</span>
        </label>
      ))}
    </div>
  );
}

function InviteForm({ organizationId }: { organizationId: string }) {
  const t = useT();
  const invite = useInviteMember(organizationId);
  const [email, setEmail] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [created, setCreated] = useState<{ acceptUrl: string; emailSent: boolean; email: string } | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invitedEmail = email;
    invite.mutate(
      { email, permissions },
      {
        onSuccess: (result) => {
          setCreated({ acceptUrl: result.acceptUrl, emailSent: result.emailSent, email: invitedEmail });
          setEmail("");
          setPermissions([]);
        },
      },
    );
  }

  return (
    <form className="space-y-3 border-t border-border pt-3" onSubmit={handleSubmit}>
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.inviteTitle")}</p>
      <label className="block text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.emailLabel")}</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
        />
      </label>
      <div>
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.permissionsLabel")}</span>
        <PermissionCheckboxes selected={permissions} onChange={setPermissions} />
      </div>
      {invite.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {invite.error instanceof ApiRequestError ? invite.error.message : t("organizations.inviteFailed")}
        </p>
      ) : null}
      {created ? (
        <p className="border border-border bg-surface p-2 text-[11px] text-foreground-muted">
          {created.emailSent ? (
            t("organizations.inviteEmailSent", { email: created.email })
          ) : (
            t("organizations.inviteNoEmail", { email: created.email })
          )}
          <br />
          <span className="font-mono break-all text-foreground">{created.acceptUrl}</span>
        </p>
      ) : null}
      <Button type="submit" variant="primary" loading={invite.isPending}>
        {t("organizations.createInvite")}
      </Button>
    </form>
  );
}

export function MembersPanel({ organizationId }: { organizationId: string }) {
  const t = useT();
  const permissions = useOrgPermissions(organizationId);
  const canRead = permissions.includes("members:read");
  const canInvite = permissions.includes("members:invite");
  const canManage = permissions.includes("members:manage");

  const members = useMembers(organizationId);
  const updateMember = useUpdateMember(organizationId);
  const revokeMember = useRevokeMember(organizationId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPermissions, setEditPermissions] = useState<string[]>([]);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);

  if (!canRead) {
    return <EmptyState title={t("organizations.membersNoPermissionTitle")} description={t("organizations.membersNoPermissionDescription")} />;
  }

  if (members.isPending) return <LoadingState label={t("organizations.loadingMembers")} />;
  if (members.isError) return <ErrorState error={members.error} onRetry={() => members.refetch()} />;

  const rows = members.data.data;

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState title={t("organizations.membersEmpty")} />
      ) : (
        <Table>
          <Thead>
            <Tr className="hover:bg-transparent">
              <Th className="text-[10px]">{t("organizations.emailLabel")}</Th>
              <Th className="text-[10px]">{t("organizations.colStatus")}</Th>
              <Th className="text-[10px]">{t("organizations.permissionsLabel")}</Th>
              <Th className="text-[10px]">{t("organizations.colInvited")}</Th>
              {canManage ? <Th className="w-[10px]" aria-label={t("organizations.colActions")} /> : null}
            </Tr>
          </Thead>
          <Tbody>
            {rows.map((row) => (
              <Tr key={row.id}>
                <Td className="text-sm font-medium text-foreground">{row.email}</Td>
                <Td>
                  <Badge tone={row.status === "active" ? "success" : row.status === "pending" ? "warning" : "neutral"} variant="dot">
                    {MEMBER_STATUS_LABELS[row.status] ? t(MEMBER_STATUS_LABELS[row.status]!) : row.status}
                  </Badge>
                </Td>
                <Td>
                  {editingId === row.id ? (
                    <div className="space-y-2">
                      <PermissionCheckboxes selected={editPermissions} onChange={setEditPermissions} />
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          loading={updateMember.isPending}
                          onClick={() =>
                            updateMember.mutate({ membershipId: row.id, input: { permissions: editPermissions } }, { onSuccess: () => setEditingId(null) })
                          }
                        >
                          {t("common.save")}
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <span className="font-mono text-[10.5px] text-foreground-subtle">{row.permissions.join(", ") || t("organizations.permissionsNone")}</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap font-mono text-[10.5px] text-foreground-muted">{formatDateTime(row.invitedAt)}</Td>
                {canManage ? (
                  <Td>
                    {editingId !== row.id && row.status !== "revoked" ? (
                      <div className="flex gap-2">
                        {row.status === "pending" ? (
                          <Button
                            variant="primary"
                            loading={updateMember.isPending}
                            onClick={() => updateMember.mutate({ membershipId: row.id, input: { status: "active" } })}
                          >
                            {t("organizations.activateNow")}
                          </Button>
                        ) : null}
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditingId(row.id);
                            setEditPermissions(row.permissions);
                          }}
                        >
                          {t("organizations.edit")}
                        </Button>
                        <Button variant="danger" onClick={() => setPendingRevoke(row.id)}>
                          {t("organizations.revoke")}
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                ) : null}
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}

      {canInvite ? <InviteForm organizationId={organizationId} /> : null}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={t("organizations.revokeMemberTitle")}
        description={t("organizations.revokeMemberDescription")}
        confirmLabel={t("organizations.revoke")}
        loading={revokeMember.isPending}
        onConfirm={() => {
          if (pendingRevoke) revokeMember.mutate(pendingRevoke, { onSuccess: () => setPendingRevoke(null) });
        }}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
