/**
 * The closed permission-string catalog every Membership.permissions entry
 * must be drawn from — same "these are the only valid values, enforced by
 * code, not convention" posture as modules/destinations/types.ts's
 * SUPPORTED_CHANNEL_TYPES. requirePermission() (api/plugins/requirePermission.ts)
 * checks membership.permissions against these strings; the member-management
 * routes (api/routes/members.ts) validate every incoming permission string
 * against isPermission() before persisting.
 *
 * `resource:action` shaped. Notable splits, not arbitrary granularity:
 *   - destinations:manage_secrets is separate from destinations:write —
 *     rotating a webhook's signing secret is more sensitive than editing its
 *     non-secret config (name, channel type, target folder/URL).
 *   - members:invite is separate from members:manage — adding a new,
 *     initially low-privilege member is lower-stakes than regranting or
 *     revoking an EXISTING member's access (possibly a peer's).
 * Organization CREATION (POST /organizations) has no target Membership to
 * check against yet — it is superAdmin-only, deliberately outside this
 * per-Membership catalog (see tenantContext.ts / organizations routes).
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
  // Phase 18: re-run routing for already-processed emails (runs actions again).
  "emails:reprocess",

  "routing_decisions:read",

  "action_executions:read",
  "action_executions:retry",
  // Phase 15: move an archived message back to its original folder.
  "action_executions:undo",

  "reviews:read",
  "reviews:resolve",

  "audit:read",
  // Phase 20: delete everything held about one sender (KVKK/GDPR request).
  "privacy:erase",

  "stats:read",

  "members:read",
  "members:invite",
  "members:manage",
  // Phase 20: create and revoke this organization's API keys.
  "api_keys:manage",
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSION_CATALOG as readonly string[]).includes(value);
}
