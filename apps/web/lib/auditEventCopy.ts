import type { BadgeTone } from "@/components/ui/Badge";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

/**
 * Human-readable label + tone for every AuditEventType the backend actually
 * emits (apps/api/src/modules/audit/record.ts's AuditEventType). Shared by
 * the Overview activity feed and the Audit page (§4/§21) so the two never
 * describe the same event type differently. An unrecognized type (a future
 * backend event this UI hasn't been updated for) falls back to the raw
 * string rather than crashing or hiding the event.
 */
export const AUDIT_EVENT_COPY: Record<string, { label: MessageKey; tone: BadgeTone }> = {
  email_discovered: { label: "audit.eventEmailDiscovered", tone: "neutral" },
  email_queued_for_processing: { label: "audit.eventEmailQueuedForProcessing", tone: "neutral" },
  email_processing_failed: { label: "audit.eventEmailProcessingFailed", tone: "danger" },
  email_routed_to_review: { label: "audit.eventEmailRoutedToReview", tone: "warning" },

  mailbox_sync_started: { label: "audit.eventMailboxSyncStarted", tone: "neutral" },
  mailbox_sync_completed: { label: "audit.eventMailboxSyncCompleted", tone: "success" },
  mailbox_sync_failed: { label: "audit.eventMailboxSyncFailed", tone: "danger" },
  mailbox_sync_skipped_concurrent: { label: "audit.eventMailboxSyncSkippedConcurrent", tone: "neutral" },
  mailbox_uidvalidity_changed: { label: "audit.eventMailboxUidvalidityChanged", tone: "warning" },

  analysis_started: { label: "audit.eventAnalysisStarted", tone: "neutral" },
  analysis_succeeded: { label: "audit.eventAnalysisSucceeded", tone: "success" },
  analysis_failed: { label: "audit.eventAnalysisFailed", tone: "danger" },

  rule_evaluation_started: { label: "audit.eventRuleEvaluationStarted", tone: "neutral" },
  rule_matched: { label: "audit.eventRuleMatched", tone: "success" },
  rule_unmatched: { label: "audit.eventRuleUnmatched", tone: "warning" },
  rule_graph_routed: { label: "audit.eventRuleGraphRouted", tone: "success" },
  rule_graph_invalid: { label: "audit.eventRuleGraphInvalid", tone: "danger" },
  rule_graph_enabled: { label: "audit.eventRuleGraphEnabled", tone: "info" },
  rule_graph_disabled: { label: "audit.eventRuleGraphDisabled", tone: "warning" },
  forward_recipient_requested: { label: "audit.eventForwardRecipientRequested", tone: "info" },
  forward_recipient_verified: { label: "audit.eventForwardRecipientVerified", tone: "success" },
  forward_recipient_revoked: { label: "audit.eventForwardRecipientRevoked", tone: "warning" },
  forward_digest_sent: { label: "audit.eventForwardDigestSent", tone: "success" },
  forward_digest_cancelled: { label: "audit.eventForwardDigestCancelled", tone: "warning" },
  action_undone: { label: "audit.eventActionUndone", tone: "info" },
  action_undo_failed: { label: "audit.eventActionUndoFailed", tone: "danger" },
  email_restored_after_undo: { label: "audit.eventEmailRestoredAfterUndo", tone: "neutral" },
  sender_allowed: { label: "audit.eventSenderAllowed", tone: "success" },
  sender_blocked: { label: "audit.eventSenderBlocked", tone: "warning" },
  rules_imported: { label: "audit.eventRulesImported", tone: "info" },
  privacy_sender_erased: { label: "audit.eventPrivacySenderErased", tone: "warning" },
  sender_list_entry_added: { label: "audit.eventSenderListEntryAdded", tone: "info" },
  sender_list_entry_removed: { label: "audit.eventSenderListEntryRemoved", tone: "neutral" },
  routing_suggestion_accepted: { label: "audit.eventRoutingSuggestionAccepted", tone: "info" },
  routing_suggestion_dismissed: { label: "audit.eventRoutingSuggestionDismissed", tone: "neutral" },
  mailbox_oauth_connected: { label: "audit.eventMailboxOauthConnected", tone: "success" },
  mailbox_reauth_required: { label: "audit.eventMailboxReauthRequired", tone: "danger" },
  email_reprocessed: { label: "audit.eventEmailReprocessed", tone: "info" },
  alert_opened: { label: "audit.eventAlertOpened", tone: "danger" },
  alert_resolved: { label: "audit.eventAlertResolved", tone: "success" },
  human_review_signal_forced_review: { label: "audit.eventHumanReviewSignalForcedReview", tone: "warning" },
  routing_decision_created: { label: "audit.eventRoutingDecisionCreated", tone: "info" },
  destination_resolution_failed: { label: "audit.eventDestinationResolutionFailed", tone: "danger" },

  action_execution_started: { label: "audit.eventActionExecutionStarted", tone: "neutral" },
  action_execution_succeeded: { label: "audit.eventActionExecutionSucceeded", tone: "success" },
  action_execution_failed: { label: "audit.eventActionExecutionFailed", tone: "danger" },
  action_execution_ambiguous: { label: "audit.eventActionExecutionAmbiguous", tone: "warning" },

  organization_created: { label: "audit.eventOrganizationCreated", tone: "success" },
  organization_updated: { label: "audit.eventOrganizationUpdated", tone: "neutral" },
  organization_deactivated: { label: "audit.eventOrganizationDeactivated", tone: "warning" },
  mailbox_created: { label: "audit.eventMailboxCreated", tone: "success" },
  mailbox_updated: { label: "audit.eventMailboxUpdated", tone: "neutral" },
  mailbox_deactivated: { label: "audit.eventMailboxDeactivated", tone: "warning" },
  mailbox_credential_set: { label: "audit.eventMailboxCredentialSet", tone: "neutral" },
  mailbox_rule_graph_assigned: { label: "audit.eventMailboxRuleGraphAssigned", tone: "info" },

  human_review_resolved: { label: "audit.eventHumanReviewResolved", tone: "success" },
};

/** Pass the rendering component's `useT()`; labels are message keys, translated here. */
export function describeAuditEvent(eventType: string, t: Translate): { label: string; tone: BadgeTone } {
  const entry = AUDIT_EVENT_COPY[eventType];
  return entry ? { label: t(entry.label), tone: entry.tone } : { label: eventType, tone: "neutral" };
}
