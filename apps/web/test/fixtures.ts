import type { ActionExecutionResponse, EmailDetailResponse } from "@/types/api";

export function makeEmail(overrides: Partial<EmailDetailResponse> = {}): EmailDetailResponse {
  return {
    id: "email-1",
    tenantId: "tenant-1",
    mailboxConnectionId: "mailbox-1",
    provider: "imap",
    externalId: "42",
    fromAddress: "alice@example.com",
    toAddresses: ["bob@eumaeus.test"],
    subject: "Test subject",
    receivedAt: "2026-01-01T10:00:00.000Z",
    hasAttachments: false,
    state: "analyzed",
    stateUpdatedAt: "2026-01-01T10:00:05.000Z",
    ingestedAt: "2026-01-01T10:00:00.000Z",
    ccAddresses: [],
    bccAddresses: [],
    messageId: null,
    threadId: null,
    uidValidity: 1,
    attachments: [],
    body: null,
    analysis: null,
    routingDecision: null,
    previousRoutingDecisions: [],
    actionExecutions: [],
    reviewItems: [],
    ...overrides,
  };
}

export function makeActionExecution(overrides: Partial<ActionExecutionResponse> = {}): ActionExecutionResponse {
  return {
    id: "exec-1",
    tenantId: "tenant-1",
    emailId: "email-1",
    routingDecisionId: "rd-1",
    destinationChannelId: "channel-1",
    channelType: "webhook",
    details: null,
    channelVersion: 1,
    idempotencyKey: "email-1:rd-1:channel-1",
    attemptNumber: 1,
    status: "failed",
    retryable: true,
    errorClass: "connection",
    errorMessage: "ECONNREFUSED",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:01.000Z",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}
