"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n/locales";

/**
 * One centralized query/cache client (§25: "prefer centralized query/cache
 * behavior... do not add a heavy data-fetching framework without
 * justification"). react-query is the justification: it replaces what would
 * otherwise be per-component `useEffect`+`fetch`+loading-state boilerplate
 * repeated on every page, and gives every list/detail page the SAME
 * loading/error/empty handling for free via one shared convention
 * (hooks/use*.ts). A moderate default staleTime avoids refetching on every
 * remount without any explicit polling interval anywhere by default —
 * individual hooks opt into a `refetchInterval` only where the backend state
 * genuinely changes on its own (Human Review backlog, a still-pending
 * ActionExecution) — see hooks/useReviews.ts and hooks/useActionExecution.ts.
 */
export function Providers({ children, locale }: { children: React.ReactNode; locale: Locale }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <OrganizationCacheReset />
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

/** Query keys whose data doesn't depend on the selected organization. */
const ORGANIZATION_INDEPENDENT = new Set(["auth", "organizations", "organization", "settings", "mailbox-oauth-providers", "host-report", "queue-health"]);

/**
 * Many list queries are keyed without the organization (["emails", filters],
 * ["reviews", filters], …) while the organization travels in a header. When
 * the selected organization changes, their cached pages belong to the old one:
 * reset them all (active ones refetch, showing a loading state instead of the
 * previous organization's rows) rather than relying on every hook's key.
 */
export function OrganizationCacheReset() {
  const queryClient = useQueryClient();
  const organizationId = useCurrentOrganizationId();
  const previous = useRef(organizationId);
  useEffect(() => {
    if (previous.current === organizationId) return;
    previous.current = organizationId;
    void queryClient.resetQueries({ predicate: (query) => !ORGANIZATION_INDEPENDENT.has(String(query.queryKey[0])) });
  }, [organizationId, queryClient]);
  return null;
}
