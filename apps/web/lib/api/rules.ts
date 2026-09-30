import { ApiRequestError, apiRequest } from "./client";
import type { ConditionNode, CursorPage, RuleResponse } from "@/types/api";

export interface ListRulesParams {
  limit?: number;
  cursor?: string;
  enabled?: "true" | "false";
}

export function listRules(params: ListRulesParams = {}, signal?: AbortSignal) {
  return apiRequest<CursorPage<RuleResponse>>("/api/v1/rules", {
    query: params,
    signal,
  });
}

export function getRule(id: string, signal?: AbortSignal) {
  return apiRequest<RuleResponse>(`/api/v1/rules/${id}`, { signal });
}

export interface RuleInput {
  name: string;
  priority: number;
  conditions: ConditionNode;
  destinationRef: string;
}

export interface SaveRuleOptions {
  /** Set after the user saw the impact preview and accepted that business mail moves to a junk-like destination; otherwise such a change is refused with 409 and `details.impact`. */
  confirmImpact?: boolean;
}

export function createRule(input: RuleInput, options: SaveRuleOptions = {}) {
  return apiRequest<RuleResponse>("/api/v1/rules", {
    method: "POST",
    body: options.confirmImpact ? { ...input, confirmImpact: true } : input,
  });
}

/** Creates a NEW version (the backend never mutates a rule in place) — see components/rules' UI copy, which must never describe this as an in-place edit. */
export function updateRule(id: string, input: RuleInput, options: SaveRuleOptions = {}) {
  return apiRequest<RuleResponse>(`/api/v1/rules/${id}`, {
    method: "PATCH",
    body: options.confirmImpact ? { ...input, confirmImpact: true } : input,
  });
}

/** Deactivates (soft) — the row and its history remain. */
export function deactivateRule(id: string, options: SaveRuleOptions = {}) {
  return apiRequest<void>(`/api/v1/rules/${id}`, {
    method: "DELETE",
    query: options.confirmImpact ? { confirmImpact: "true" } : undefined,
  });
}

/** Rule change impact: what a create/edit/delete would do to the last days' emails. */
export type RuleChange =
  | { type: "create"; rule: RuleInput }
  | { type: "update"; ruleId: string; rule: RuleInput }
  | { type: "delete"; ruleId: string };

export interface RuleImpactSample {
  emailId: string;
  subject: string | null;
  fromAddress: string;
  receivedAt: string;
  from: string;
  to: string;
  reason?: string;
}

export interface RuleImpact {
  days: number;
  evaluated: number;
  truncated: boolean;
  draftMatches: number;
  currentMatches: number;
  changed: number;
  moves: Array<{ from: string; to: string; count: number }>;
  shadowedBy: Array<{ by: string; count: number }>;
  risky: { count: number; samples: RuleImpactSample[] };
  samples: RuleImpactSample[];
  divergence: number;
  warnings: string[];
}

export function previewRuleImpact(change: RuleChange, days?: number) {
  return apiRequest<RuleImpact>("/api/v1/rules/impact", {
    method: "POST",
    body: days === undefined ? { change } : { change, days },
  });
}

/** The impact attached to a 409 from a save/delete that needs confirmation, or null. */
export function impactFromError(error: unknown): RuleImpact | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const details = error.details as { impact?: RuleImpact } | undefined;
  return details?.impact && typeof details.impact === "object" ? details.impact : null;
}

/** Rule sets as JSON (Phase 19). */
export interface RuleExportFile {
  format: "eumaeus.rules";
  version: 1;
  exportedAt: string;
  organization: string;
  destinations: string[];
  rules: RuleInput[];
}

export interface RuleImportIssue {
  index: number;
  name: string;
  message: string;
}

export interface RuleImportResult {
  dryRun: boolean;
  valid: boolean;
  created: number;
  deactivated: number;
  rules: Array<{ name: string; priority: number; destinationRef: string }>;
  errors: RuleImportIssue[];
  warnings: RuleImportIssue[];
}

export interface RuleImportRequest {
  rules: unknown;
  mode: "add" | "replace";
  priorities: "keep" | "append";
  dryRun: boolean;
}

export function exportRules() {
  return apiRequest<RuleExportFile>("/api/v1/rules/export");
}

export function importRules(body: RuleImportRequest) {
  return apiRequest<RuleImportResult>("/api/v1/rules/import", {
    method: "POST",
    body,
  });
}

/** Phase 25: one version of a rule's lineage (oldest first). */
export interface RuleVersion {
  id: string;
  version: number;
  name: string;
  priority: number;
  destinationRef: string;
  conditions: ConditionNode;
  createdAt: string;
  deactivatedAt: string | null;
  active: boolean;
  matches: number;
}

export function listRuleVersions(id: string, signal?: AbortSignal) {
  return apiRequest<{ data: RuleVersion[] }>(`/api/v1/rules/${id}/versions`, { signal });
}

/** Saves the chosen version's content as a new version (or restores a deleted rule with it). */
export function revertRule(id: string, input: { version: number; priority?: number; confirmImpact?: boolean }) {
  return apiRequest<{ rule: RuleResponse; restored: boolean; impact: RuleImpact }>(`/api/v1/rules/${id}/revert`, { method: "POST", body: input });
}
