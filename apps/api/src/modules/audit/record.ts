import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The single write path for AuditEvent rows (implementation-plan.md §N / §B).
 *
 * Every other module writes through this function instead of calling
 * `prisma.auditEvent.create` directly, and always as part of the same transaction
 * as the state change it's recording — a state transition that can't be audited
 * must not be allowed to happen silently (principle #19).
 *
 * Accepts a Prisma transaction client (`tx`) so callers can include the audit write
 * in their own transaction; pass the plain `prisma` client when there is no
 * surrounding transaction (e.g. a standalone diagnostic event).
 */
export interface AuditEventInput {
  tenantId: string;
  emailId?: string;
  eventType: string;
  payload?: Prisma.InputJsonValue;
  actor: string;
}

export async function recordAuditEvent(
  client: PrismaClient | Prisma.TransactionClient,
  input: AuditEventInput,
): Promise<void> {
  await client.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      emailId: input.emailId,
      eventType: input.eventType,
      payload: input.payload,
      actor: input.actor,
    },
  });
}

/** Event type constants. New ones are added here as later phases add them — this is the only place event type strings are defined. */
export const AuditEventType = {
  EMAIL_DISCOVERED: "email_discovered",
  EMAIL_QUEUED_FOR_PROCESSING: "email_queued_for_processing",
  EMAIL_PROCESSING_FAILED: "email_processing_failed",
  EMAIL_ROUTED_TO_REVIEW: "email_routed_to_review",
  MAILBOX_SYNC_STARTED: "mailbox_sync_started",
  MAILBOX_SYNC_COMPLETED: "mailbox_sync_completed",
  MAILBOX_SYNC_FAILED: "mailbox_sync_failed",
  MAILBOX_SYNC_SKIPPED_CONCURRENT: "mailbox_sync_skipped_concurrent",
  MAILBOX_UIDVALIDITY_CHANGED: "mailbox_uidvalidity_changed",
  // --- Phase 3: Jev analysis lifecycle ---
  ANALYSIS_STARTED: "analysis_started",
  ANALYSIS_SUCCEEDED: "analysis_succeeded",
  ANALYSIS_FAILED: "analysis_failed",
  // --- Phase 4: Rule Engine lifecycle ---
  RULE_EVALUATION_STARTED: "rule_evaluation_started",
  RULE_MATCHED: "rule_matched",
  RULE_UNMATCHED: "rule_unmatched",
  // --- Phase 12: RuleGraph execution ---
  RULE_GRAPH_ROUTED: "rule_graph_routed",
  RULE_GRAPH_INVALID: "rule_graph_invalid",
  RULE_GRAPH_ENABLED: "rule_graph_enabled",
  RULE_GRAPH_DISABLED: "rule_graph_disabled",
  // --- Phase 13: forwarding recipients ---
  FORWARD_RECIPIENT_REQUESTED: "forward_recipient_requested",
  FORWARD_RECIPIENT_VERIFIED: "forward_recipient_verified",
  FORWARD_RECIPIENT_REVOKED: "forward_recipient_revoked",
  FORWARD_DIGEST_SENT: "forward_digest_sent",
  FORWARD_DIGEST_CANCELLED: "forward_digest_cancelled",
  // --- Phase 15: undo ---
  ACTION_UNDONE: "action_undone",
  ACTION_UNDO_FAILED: "action_undo_failed",
  EMAIL_RESTORED_AFTER_UNDO: "email_restored_after_undo",
  // --- Phase 16: sender lists and suggestions ---
  SENDER_ALLOWED: "sender_allowed",
  SENDER_BLOCKED: "sender_blocked",
  RULES_IMPORTED: "rules_imported",
  // Phase 25: a rule went back to an earlier version (or was restored).
  RULE_REVERTED: "rule_reverted",
  // Phase 24: a person put an email where it belongs.
  EMAIL_CORRECTED: "email_corrected",
  // Phase 28: teamwork on Human Review — payload { reviewItemId, assignedTo, assignedToEmail } / { reviewItemId, text }.
  REVIEW_ASSIGNED: "review_assigned",
  REVIEW_NOTE_ADDED: "review_note_added",
  // Permanent deletion (superAdmin): a mailbox with its emails; selected emails.
  // (An organization's own deletion is recorded as an AuthEvent — its audit trail goes with it.)
  MAILBOX_DELETED: "mailbox_deleted",
  EMAILS_DELETED: "emails_deleted",
  ORGANIZATION_REACTIVATED: "organization_reactivated",
  // Phase 22: custom Jev questions.
  QUESTION_CREATED: "question_created",
  QUESTION_UPDATED: "question_updated",
  QUESTION_DELETED: "question_deleted",
  API_KEY_CREATED: "api_key_created",
  API_KEY_REVOKED: "api_key_revoked",
  // Phase 20: payload carries a SHA-256 of the address, never the address.
  PRIVACY_SENDER_ERASED: "privacy_sender_erased",
  SENDER_LIST_ENTRY_ADDED: "sender_list_entry_added",
  SENDER_LIST_ENTRY_REMOVED: "sender_list_entry_removed",
  ROUTING_SUGGESTION_ACCEPTED: "routing_suggestion_accepted",
  ROUTING_SUGGESTION_DISMISSED: "routing_suggestion_dismissed",
  // --- Phase 17: OAuth mailboxes ---
  MAILBOX_OAUTH_CONNECTED: "mailbox_oauth_connected",
  MAILBOX_REAUTH_REQUIRED: "mailbox_reauth_required",
  // --- Phase 18: operations ---
  EMAIL_REPROCESSED: "email_reprocessed",
  ALERT_OPENED: "alert_opened",
  ALERT_RESOLVED: "alert_resolved",
  ALERT_DISMISSED: "alert_dismissed",
  HUMAN_REVIEW_SIGNAL_FORCED_REVIEW: "human_review_signal_forced_review",
  ROUTING_DECISION_CREATED: "routing_decision_created",
  // --- Phase 5A: destination execution lifecycle ---
  DESTINATION_RESOLUTION_FAILED: "destination_resolution_failed",
  ACTION_EXECUTION_STARTED: "action_execution_started",
  ACTION_EXECUTION_SUCCEEDED: "action_execution_succeeded",
  ACTION_EXECUTION_FAILED: "action_execution_failed",
  ACTION_EXECUTION_AMBIGUOUS: "action_execution_ambiguous",
  // --- Phase 10: Organization / multi-mailbox lifecycle ---
  ORGANIZATION_CREATED: "organization_created",
  ORGANIZATION_UPDATED: "organization_updated",
  ORGANIZATION_DEACTIVATED: "organization_deactivated",
  MAILBOX_CREATED: "mailbox_created",
  MAILBOX_UPDATED: "mailbox_updated",
  MAILBOX_DEACTIVATED: "mailbox_deactivated",
  // Payload is always { mailboxConnectionId } ONLY — never the credential value itself.
  MAILBOX_CREDENTIAL_SET: "mailbox_credential_set",
  MAILBOX_RULE_GRAPH_ASSIGNED: "mailbox_rule_graph_assigned",
  // --- Phase 10.2: Human Review resolution outcome ---
  HUMAN_REVIEW_RESOLVED: "human_review_resolved",
} as const;
