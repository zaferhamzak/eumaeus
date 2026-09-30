"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import {
  listRuleFields,
  STATIC_RULE_FIELDS,
  type RuleFieldInfo,
} from "@/lib/ruleFields";

/**
 * Phase 22: the organization's rule field catalog (built-in, derived and its
 * own custom Jev questions). Until the request answers — or if it fails — the
 * static built-in list is used, so the editor always works.
 */
export function useRuleFields(): {
  fields: readonly RuleFieldInfo[];
  isFetched: boolean;
} {
  const organizationId = useCurrentOrganizationId();
  const query = useQuery({
    queryKey: ["rule-fields", organizationId],
    queryFn: ({ signal }) => listRuleFields(signal),
    staleTime: 60_000,
  });
  const fields =
    query.data?.data && query.data.data.length > 0
      ? query.data.data
      : STATIC_RULE_FIELDS;
  return { fields, isFetched: query.isFetched };
}
