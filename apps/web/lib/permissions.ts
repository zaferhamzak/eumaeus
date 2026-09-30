/**
 * Hand-mirrored from apps/api/src/modules/auth/permissions.ts's
 * PERMISSION_CATALOG — same "no shared-types package in this monorepo"
 * reasoning as types/api.ts. Used by the Members tab's permission checkbox
 * list (components/organizations/MembersPanel.tsx) and useHasPermission.
 */
export const PERMISSION_CATALOG = [
  "organizations:read",
  "organizations:write",
  "organizations:delete",
  "mailboxes:read",
  "mailboxes:write",
  "mailboxes:delete",
  "mailboxes:reconcile",
  "destinations:read",
  "destinations:write",
  "destinations:delete",
  "destinations:manage_secrets",
  "rules:read",
  "rules:write",
  "rules:delete",
  "rule_graphs:read",
  "rule_graphs:write",
  "emails:read",
  "emails:reprocess",
  "routing_decisions:read",
  "action_executions:read",
  "action_executions:retry",
  "action_executions:undo",
  "reviews:read",
  "reviews:resolve",
  "audit:read",
  "privacy:erase",
  "stats:read",
  "members:read",
  "members:invite",
  "members:manage",
  "api_keys:manage",
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number];
