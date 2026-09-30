/**
 * Hand-mirrored from apps/api's actual serializers (src/api/serializers/*.ts)
 * — there is no shared-types package in this monorepo, so this file is the
 * one place that shape drift between the backend and this UI would surface
 * (a field renamed on the backend without updating this file breaks the
 * build here, loudly, at compile time — not silently at runtime).
 */

export interface CursorPage<T> {
  data: T[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "FORBIDDEN";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

// --- Organizations ---

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  humanReviewSignalEnabled: boolean;
  humanReviewSignalThreshold: number;
  reviewDigestEnabled: boolean;
  reviewDigestIntervalMinutes: number;
  /** Email members about items assigned to them once this many have gathered. */
  assignmentNotifyEnabled: boolean;
  assignmentNotifyThreshold: number;
  lastReviewDigestAt: string | null;
  forwardDailyLimit: number;
  forwardAllowedDomains: string[];
  bodyRetentionDays: number | null;
  emailRetentionDays: number | null;
  /** Phase 21: language of emails to people who aren't users. */
  locale: string;
  blockDestinationRef: string | null;
  alertEmailsEnabled: boolean;
  alertWebhookOrigin: string | null;
  /** Phase 22: working hours for the email.business_hours condition; null = not set (the condition never matches). */
  businessHours: {
    timeZone: string;
    /** ISO weekdays, Mon=1 … Sun=7. */
    days: number[];
    start: string;
    end: string;
  } | null;
  createdAt: string;
}

export interface ForwardRecipientResponse {
  id: string;
  address: string;
  /** pending | verified | revoked */
  status: string;
  requestedBy: string | null;
  verifiedAt: string | null;
  linkExpiresAt: string | null;
  createdAt: string;
}

// --- Mailboxes ---

export interface MailboxConnectionResponse {
  id: string;
  organizationId: string;
  name: string | null;
  provider: string;
  emailAddress: string;
  /** "password", "oauth_google" or "oauth_microsoft". */
  authType: string;
  host: string | null;
  port: number | null;
  tls: boolean | null;
  folder: string | null;
  username: string | null;
  ruleGraphId: string | null;
  status: string;
  syncStatus: string;
  lastSyncAttemptAt: string | null;
  lastSyncSuccessAt: string | null;
  lastSyncFailureAt: string | null;
  lastSyncError: string | null;
  lastUidValidity: number | null;
  lastSyncedUid: number | null;
  createdAt: string;
}

// --- Destinations ---

export interface DestinationChannelResponse {
  id: string;
  type: string;
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** Live forward channels with delivery "digest", on the detail endpoint only. */
  digest?: { pending: number; lastSentAt: string | null };
}

export interface DestinationResponse {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  channels: DestinationChannelResponse[];
  createdAt: string;
  updatedAt: string;
}

export interface DestinationSecretResponse {
  id: string;
  destinationId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// --- Rules ---

export type ComparisonOp = "==" | "!=" | ">=" | "<=" | ">" | "<" | "in" | "contains";

export interface ConditionLeaf {
  field: string;
  op: ComparisonOp;
  value: string | number | boolean | (string | number)[];
}
export interface ConditionGroup {
  op: "AND" | "OR";
  children: ConditionNode[];
}
export interface ConditionNot {
  op: "NOT";
  child: ConditionNode;
}
export type ConditionNode = ConditionLeaf | ConditionGroup | ConditionNot;

export interface RuleResponse {
  id: string;
  tenantId: string;
  name: string;
  priority: number;
  enabled: boolean;
  version: number;
  conditions: ConditionNode;
  destinationRef: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** Counted since this version of the rule was saved. */
  stats?: { matchesLast7Days: number; matchesLast30Days: number; evaluationsLast30Days: number; lastMatchedAt: string | null };
}

// --- Simulations (Phase 14) ---

export interface SimulatedRoute {
  /** A destination name, or "human_review". */
  destinationRef: string;
  kind: string;
  ruleId?: string;
  ruleName?: string;
  path?: Array<{ nodeKey: string; matched: boolean }>;
}

export interface SimulationSample {
  emailId: string;
  subject: string | null;
  fromAddress: string;
  receivedAt: string;
  before: SimulatedRoute | null;
  after: SimulatedRoute;
  changed: boolean;
}

export interface SimulationResult {
  evaluated: number;
  truncated: boolean;
  withoutAnalysis: number;
  draftMatched: number;
  decidedByAssignedGraph: number;
  forcedToReview: number;
  byDestination: Array<{ destinationRef: string; count: number }>;
  changed: number;
  samples: SimulationSample[];
}

// --- Emails ---

export interface EmailSummaryResponse {
  id: string;
  tenantId: string;
  mailboxConnectionId: string;
  provider: string;
  externalId: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  receivedAt: string;
  hasAttachments: boolean;
  state: string;
  stateUpdatedAt: string;
  ingestedAt: string;
}

export interface AttachmentMetaResponse {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

export interface AnalysisResultResponse {
  id: string;
  emailId: string;
  schemaVersion: string;
  jevModel: string;
  status: string;
  answers: Record<string, JevAnswer> | null;
  errorClass: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  inputTruncated: boolean;
  createdAt: string;
}

/** The three Jev answer primitive shapes (docs.typesafe.ai) — see modules/jev/response.ts on the backend. */
export type JevAnswer =
  | { noul: number }
  | { choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { score: number; legend?: Record<string, string>; probabilities?: Record<string, number>; confidence?: number };

export interface RoutingDecisionResponse {
  id: string;
  tenantId: string;
  emailId: string;
  status: string;
  matchedRuleId: string | null;
  matchedRuleVersion: number | null;
  destinationRef: string | null;
  ruleGraphId: string | null;
  ruleGraphVersion: number | null;
  graphPath: Array<{ nodeKey: string; matched: boolean }> | null;
  /** Phase 16: set when an allow / block list entry decided the email. */
  senderListEntryId: string | null;
  senderListPattern: string | null;
  /** Phase 18: set when a reprocess replaced this decision. */
  supersededAt: string | null;
  analysisResultId: string | null;
  createdAt: string;
}

// --- Sender lists and suggestions (Phase 16) ---

export interface SenderListEntryResponse {
  id: string;
  kind: "allow" | "block";
  pattern: string;
  note: string | null;
  source: "manual" | "suggestion";
  createdBy: string | null;
  createdAt: string;
}

export interface RoutingSuggestionResponse {
  id: string;
  kind: "allow" | "block";
  pattern: string;
  resolvedCount: number;
  spamCount: number;
  approvedCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionExecutionResponse {
  id: string;
  tenantId: string;
  emailId: string;
  routingDecisionId: string;
  destinationChannelId: string;
  channelType: string;
  channelVersion: number;
  idempotencyKey: string;
  attemptNumber: number;
  status: string;
  retryable: boolean | null;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  /** Per-type facts: archive {moved, targetFolder, sourceFolder}, archive_undo {undoes, fromFolder, toFolder}, flag {applied}. */
  details: Record<string, unknown> | null;
}

export interface ReviewEmailPreview {
  subject: string | null;
  fromAddress: string;
}

/** `isSuspicious` uses the exact same 0.5 noul threshold the rule engine itself uses for `answers.is_spam == true` — see modules/rules/conditions.ts on the backend. Real Jev output, never an invented score. */
export interface ReviewSignal {
  isSpam: number | null;
  isSuspicious: boolean | null;
  category: string | null;
}

export interface ReviewItemResponse {
  id: string;
  tenantId: string;
  emailId: string;
  reason: string;
  status: string;
  resolution: string | null;
  assignedTo: string | null;
  /** Phase 28: the assignee's email (list and detail). */
  assignedToEmail?: string | null;
  resolvedAt: string | null;
  createdAt: string;
  emailPreview: ReviewEmailPreview | null;
  signal: ReviewSignal | null;
}

export interface ReviewNoteResponse {
  id: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface ReviewerResponse {
  userId: string;
  email: string;
}

export interface ReviewDetailResponse extends ReviewItemResponse {
  email: EmailSummaryResponse;
  analysis: AnalysisResultResponse | null;
  routingDecision: RoutingDecisionResponse | null;
  actionExecutions: ActionExecutionResponse[];
  recentAuditEvents: AuditEventResponse[];
  /** Phase 28: notes, oldest first (they live in the audit log). */
  notes?: ReviewNoteResponse[];
}

/** Phase 27: the receiving provider's verdict on the sender. */
export interface SenderAuthResponse {
  source: "authentication-results" | "received-spf";
  authservId?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
  spfDomain?: string;
  dkimDomains?: string[];
  authenticated?: boolean;
}

export interface EmailDetailResponse extends EmailSummaryResponse {
  ccAddresses: string[];
  bccAddresses: string[];
  messageId: string | null;
  threadId: string | null;
  uidValidity: number;
  attachments: AttachmentMetaResponse[];
  body: { text: string | null; html: string | null; truncated: boolean } | null;
  /** Phase 20: set when the retention policy removed the bodies. */
  bodyPurgedAt?: string | null;
  /** Phase 27: null = not captured (older mail) or the provider stamped no verdict. */
  senderAuthCaptured?: boolean;
  senderAuth?: SenderAuthResponse | null;
  analysis: AnalysisResultResponse | null;
  routingDecision: RoutingDecisionResponse | null;
  /** Phase 18: decisions replaced by a reprocess, newest first. */
  previousRoutingDecisions: RoutingDecisionResponse[];
  actionExecutions: ActionExecutionResponse[];
  reviewItems: ReviewItemResponse[];
}

// --- Audit ---

export interface AuditEventResponse {
  id: string;
  tenantId: string;
  emailId: string | null;
  eventType: string;
  payload: unknown;
  actor: string;
  createdAt: string;
}

// --- Health / readiness ---

export interface LivenessResponse {
  status: "ok";
}

export interface ReadinessResponse {
  status: "ok" | "error";
  checks: { database: "ok" | "error"; redis: "ok" | "error"; runtime: "ok" | "error" };
  runtimeState: string;
  /** The background worker, from its heartbeat (not part of `status`). */
  worker?: { status: "ok" | "down"; lastSeenAt: string | null };
}

// --- Stats (Phase 8's minimal read-only aggregate endpoint) ---

export interface StatsResponse {
  emails: Record<string, number>;
  actions: Record<string, number>;
  review: Record<string, number>;
  mailboxes: Record<string, number>;
}

export interface MetricsSnapshot {
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{ name: string; labels: Record<string, string>; buckets: number[]; counts: number[]; sum: number; count: number }>;
}

// --- Auth (Phase 11) ---

export interface AuthUser {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  mfaEnabled: boolean;
  /** Phase 21: "en" | "tr", or null = follow the browser. */
  locale: string | null;
}

export interface MeMembership {
  organizationId: string;
  organizationName: string;
  permissions: string[];
  status: string;
}

export interface MeResponse {
  user: AuthUser;
  memberships: MeMembership[];
}

export type LoginResponse = { mfaRequired: false } | { mfaRequired: true; pendingToken: string };

export interface MfaEnrollResponse {
  otpauthUri: string;
  qrCodeDataUri: string;
}

export interface MembershipResponse {
  id: string;
  userId: string;
  email: string;
  permissions: string[];
  status: string;
  invitedAt: string;
  acceptedAt: string | null;
}

// --- System settings (Phase 11.2) ---

export interface SettingsResponse {
  appBaseUrl: string;
  sessionTtlSeconds: number;
  mailboxSyncIntervalSeconds: number;
  rawSourceRetentionDays: number;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpPasswordSet: boolean;
  smtpFromAddress: string | null;
  smtpFromName: string;
  googleOAuthClientId: string | null;
  googleOAuthClientSecretSet: boolean;
  microsoftOAuthClientId: string | null;
  microsoftOAuthClientSecretSet: boolean;
  microsoftOAuthTenant: string;
  oauthRedirectUris: { google: string; microsoft: string };
  ssoGoogleEnabled: boolean;
  ssoMicrosoftEnabled: boolean;
  ssoAllowedDomains: string[];
  ssoRedirectUris: { google: string; microsoft: string };
  updatedAt: string;
  updatedBy: string | null;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

// --- Rule graphs (Phase 12: live-routing when assigned to a mailbox and enabled) ---

export type BranchTarget = { type: "node"; nodeKey: string } | { type: "action"; destinationRef: string };

export interface RuleNodeInput {
  key: string;
  conditions: ConditionNode;
  onTrue: BranchTarget;
  onFalse: BranchTarget;
}

export interface RuleGraphInput {
  name: string;
  rootNodeKey: string;
  nodes: RuleNodeInput[];
}

export interface RuleGraphSummaryResponse {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuleGraphResponse extends RuleGraphSummaryResponse {
  version: number;
  rootNodeKey: string;
  nodes: Array<RuleNodeInput & { id: string }>;
  versionCreatedAt: string;
}

// --- Operations (Phase 18) ---

export interface AlertResponse {
  id: string;
  kind: string;
  subjectKey: string | null;
  status: "open" | "dismissed" | "resolved";
  title: string;
  detail: string;
  /** 1.2: the values the text is built from (null = saved before 1.2 — show title/detail). */
  params?: Record<string, string | number> | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
}

export interface ReportDailyPoint {
  day: string;
  emails: number;
  spam: number;
  needsReply: number;
  reviewOpened: number;
  reviewResolved: number;
}

export interface ReportResponse {
  from: string;
  to: string;
  timeZone: string;
  totals: { emails: number; analyzed: number; spam: number; needsReply: number; reviewOpened: number; reviewResolved: number; reviewOpenNow: number; medianReviewHours: number | null };
  daily: ReportDailyPoint[];
  categories: Array<{ category: string; count: number }>;
  destinations: Array<{ destinationRef: string; count: number }>;
  rules: Array<{ ruleId: string; name: string; matches: number; tenantId: string }>;
  actions: Array<{ channelType: string; succeeded: number; failed: number; ambiguous: number }>;
  /** Emails in the period with a provider sender verdict, and how many were verified. */
  senderAuth?: { checked: number; verified: number };
}

/** One row of the host view: an organization at a glance. */
export interface HostOrganizationRow {
  tenantId: string;
  name: string;
  status: string;
  mailboxes: number;
  emails: number;
  spam: number;
  needsReply: number;
  reviewOpenNow: number;
  failedActions: number;
  openAlerts: number;
  lastEmailAt: string | null;
}

export interface HostReportResponse extends ReportResponse {
  organizations: HostOrganizationRow[];
}
