"use client";

import { useEffect } from "react";
import { useOrganizationsList } from "@/hooks/useOrganizations";
import { setCurrentOrganizationId, useCurrentOrganizationId } from "@/lib/currentOrganization";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Sets which organization every API request on this page acts as (via the
 * X-Organization-Id header — see apps/api/.../tenantContext.ts). A full
 * reload on change is deliberate, not a missed optimization: every existing
 * page's data hooks use query keys that don't include the current
 * organization (they were built before multi-organization browsing existed),
 * so a reload is the simple, reliable way to guarantee every one of them
 * refetches under the new organization rather than silently keeping stale
 * data from the previous one cached.
 *
 * Phase 11: the backend dropped its "first-created tenant" fallback —
 * X-Organization-Id is now REQUIRED on every tenant-scoped route, so there
 * is no longer a valid "no organization selected" state to offer as a menu
 * option. If nothing is selected yet, this auto-selects the caller's first
 * (membership-filtered, per listOrganizations' Phase 11 rewrite) visible
 * organization — a real one-time default, not a silent per-request fallback.
 *
 * Also self-heals a STALE selection: the stored org id is plain localStorage,
 * which persists across logging out and back in as a different account (or
 * across a membership being revoked/left pending) in the same browser — an
 * id that was valid for a previous session can easily no longer be one this
 * account can act as. useOrganizationsList() is already membership-filtered
 * server-side, so "selected id not present in this list" is a reliable,
 * real signal (not a guess) that the stored value is stale — every other
 * page would otherwise keep hitting a real 403 ("you do not have access to
 * organization ...") until the user manually opened this dropdown.
 */
export function OrganizationSwitcher() {
  const organizations = useOrganizationsList();
  const t = useT();
  const selected = useCurrentOrganizationId();
  const orgs = organizations.data?.data ?? [];
  const firstOrgId = orgs[0]?.id;
  // While the list is still loading, treat the current selection as valid —
  // otherwise every mount would momentarily look "invalid" and (once fixed
  // below) force an unnecessary reload before the real list even arrived.
  const selectedIsValid = organizations.data ? orgs.some((org) => org.id === selected) : true;

  useEffect(() => {
    if (selectedIsValid || !firstOrgId) return;
    const wasCorrectingAStaleValue = Boolean(selected);
    setCurrentOrganizationId(firstOrgId);
    // A stale value means whatever already rendered on this page likely just
    // 403'd under the wrong organization — reload so every query on the page
    // refetches under the corrected one, same as a manual switch does. Skip
    // the reload on a genuinely first-ever visit (selected was null) —
    // nothing had a chance to fail yet, a reload there would just be noise.
    if (wasCorrectingAStaleValue) window.location.reload();
  }, [selectedIsValid, firstOrgId, selected]);

  if (orgs.length === 0) return null;

  return (
    <label className="hidden items-center gap-1.5 sm:flex">
      <span className="sr-only">{t("nav.currentOrganization")}</span>
      <select
        value={selected ?? orgs[0]?.id ?? ""}
        onChange={(e) => {
          setCurrentOrganizationId(e.target.value);
          window.location.reload();
        }}
        className="h-8 border border-border bg-surface px-2 text-[11px] text-foreground"
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  );
}
