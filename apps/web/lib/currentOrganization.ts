import { useSyncExternalStore } from "react";

/**
 * The client-side half of Phase 10.1's `X-Organization-Id` mechanism (see
 * apps/api/src/api/plugins/tenantContext.ts's defaultTenantResolver). Not
 * React state — apiRequest() is a plain function, not a hook, and needs to
 * read this synchronously on every call — so this is a tiny localStorage
 * wrapper, not a context provider. `OrganizationSwitcher` (components/
 * layout/OrganizationSwitcher.tsx) is the one UI that writes to it.
 *
 * Phase 11 update: the backend no longer has a "first-created organization"
 * fallback — X-Organization-Id is now a REQUIRED header once logged in (see
 * tenantContext.ts's rewrite). No value stored here means apiRequest()
 * simply omits the header, and any tenant-scoped call 400s until one is
 * selected — OrganizationSwitcher auto-selects a sensible default (the
 * caller's only membership, if they have exactly one) right after login;
 * see app/login/page.tsx.
 */
const STORAGE_KEY = "eumaeus:current-organization-id";
/** The key used before the product was renamed; moved over on first read. */
const LEGACY_STORAGE_KEY = "jev-mail:current-organization-id";

export function getCurrentOrganizationId(): string | null {
  if (typeof window === "undefined") return null;
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current !== null) return current;
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy !== null) {
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
  return legacy;
}

export function setCurrentOrganizationId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) window.localStorage.setItem(STORAGE_KEY, id);
  else window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/**
 * The React-hook way to READ the current organization id — `useSyncExternalStore`
 * is the correct primitive for a non-React, externally-mutated source like
 * localStorage (unlike a `useEffect`+`setState` pair, it has a proper
 * SSR-consistent snapshot, so there's no hydration mismatch to work around).
 */
export function useCurrentOrganizationId(): string | null {
  return useSyncExternalStore(subscribe, getCurrentOrganizationId, () => null);
}
