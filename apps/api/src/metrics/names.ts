/** Every metric name/label combination this codebase actually emits — kept in one place so §11's coverage list can be checked against real call sites, not just claimed. */
export const MetricName = {
  EMAILS_RECEIVED: "eumaeus_emails_received_total",
  ANALYSIS_RESULT: "eumaeus_analysis_result_total", // label: status=ok|error
  RULE_EVALUATION_RESULT: "eumaeus_rule_evaluation_result_total", // label: result=matched|unmatched|invalid_config|sender_allowed|sender_blocked
  HUMAN_REVIEW_ESCALATED: "eumaeus_human_review_escalated_total", // label: reason

  ACTION_ATTEMPT: "eumaeus_action_attempt_total", // label: channelType
  ACTION_OUTCOME: "eumaeus_action_outcome_total", // labels: channelType, outcome=succeeded|retryable_failure|permanent_failure|ambiguous
  ACTION_STALE_PENDING_FINALIZED: "eumaeus_action_stale_pending_finalized_total", // label: channelType

  WEBHOOK_REQUEST: "eumaeus_webhook_request_total",
  WEBHOOK_OUTCOME: "eumaeus_webhook_outcome_total", // label: outcome=success|retryable|permanent|timeout|response_lost

  MAILBOX_SYNC_ATTEMPT: "eumaeus_mailbox_sync_attempt_total",
  MAILBOX_SYNC_RESULT: "eumaeus_mailbox_sync_result_total", // label: result=success|failure|skipped

  API_REQUEST: "eumaeus_api_requests_total", // labels: method, route, statusCode
  API_REQUEST_DURATION_MS: "eumaeus_api_request_duration_ms", // labels: method, route
} as const;
