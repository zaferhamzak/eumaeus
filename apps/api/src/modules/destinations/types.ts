/**
 * Shared types for the destinations module. This file (and everything under
 * modules/destinations/) has zero dependency on modules/jev/ — the Rule Engine and
 * Jev module never know a Destination, DestinationChannel, or ActionExecution
 * exists. See test/architecture/destinationsModuleBoundary.test.ts.
 */

/**
 * A rule's destinationRef pointing at this exact string is a reserved, code-level
 * target — NOT a name looked up against the Destination table. See
 * dispatchRoutingDecision.ts, which checks for this BEFORE any destination
 * resolution happens, and calls the existing escalateToHumanReview() directly.
 *
 * Deliberately not a DestinationChannel row (phase5-destinations-architecture.md
 * Revision 2 §7): it has no external side effect, no ambiguity to survive a crash
 * for, and escalateToHumanReview() is already its own complete, idempotent,
 * audited operation — wrapping it in ActionExecution/idempotency-key machinery
 * built for genuinely uncertain external operations would model risk that doesn't
 * exist here.
 */
export const RESERVED_HUMAN_REVIEW_DESTINATION_REF = "human_review";

/**
 * Enforced here (used by manageDestinations.ts's validation), not just documented —
 * creating a channel of any other type is rejected at save time, so "these are the
 * only supported channel types" is a property of the code, not a convention someone
 * has to remember. Phase 5A shipped "archive"; Phase 5B adds "webhook".
 */
export const SUPPORTED_CHANNEL_TYPES = ["archive", "webhook", "forward", "flag", "auto_reply", "slack", "teams", "jira", "zendesk", "email_notify"] as const;
export type SupportedChannelType = (typeof SUPPORTED_CHANNEL_TYPES)[number];

export function isSupportedChannelType(type: string): type is SupportedChannelType {
  return (SUPPORTED_CHANNEL_TYPES as readonly string[]).includes(type);
}

/**
 * Phase 15: flags an IMAP channel can set on the message. On Gmail
 * (X-GM-EXT-1) keywords become labels; elsewhere they're IMAP keywords.
 */
export interface ImapFlagOptions {
  /** Mark as read (\\Seen). */
  markSeen?: boolean;
  /** Star / flag it (\\Flagged). */
  flagged?: boolean;
  /** Custom keywords, or Gmail labels. */
  keywords?: string[];
}

export const MAX_FLAG_KEYWORDS = 10;

/** Non-secret config for an "archive" channel. Phase 15: may also set flags before moving (in the same executor, so there's no race with the move). */
export interface ArchiveChannelConfig extends ImapFlagOptions {
  /** Target IMAP folder to move the message into — provider-specific, no invented cross-provider semantics (a Gmail user might set "[Gmail]/All Mail"; a generic server might use "Archive"). */
  folder: string;
}

/** Phase 15: a "flag" channel sets flags without moving the message. At least one option must be set. */
export type FlagChannelConfig = ImapFlagOptions;

/**
 * Non-secret config for a "webhook" channel. `secretName`, if set, names a
 * DestinationSecret row scoped to the SAME Destination (see manageSecrets.ts) —
 * this config never contains the secret value itself, only a reference to it.
 * Omitting `secretName` means the webhook is sent unsigned (no X-Jev-Signature
 * header) — a deliberate, explicit choice, not a silent fallback.
 */
export interface WebhookChannelConfig {
  url: string;
  secretName?: string;
}

/**
 * Phase 13: how a "forward" channel sends the message on.
 *   attachment — a short cover note from Eumaeus with the original attached
 *                as a .eml file (headers, formatting, attachments intact).
 *   inline     — a classic "Fwd:" with the original quoted in the body and its
 *                attachments re-attached.
 *   redirect   — the original message itself, re-sent with Resent-* headers
 *                and the original From. Receiving servers often fail this on
 *                SPF/DMARC, so the UI warns before it's chosen.
 */
export const FORWARD_MODES = ["attachment", "inline", "redirect"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export const FORWARD_REPLY_TO_OPTIONS = ["original_sender", "none"] as const;
export type ForwardReplyTo = (typeof FORWARD_REPLY_TO_OPTIONS)[number];

/**
 * Phase 13.4: "each" sends every email as it's routed; "digest" queues them
 * and sends one message per channel every digestIntervalMinutes
 * (modules/destinations/forwardDigest.ts).
 */
export const FORWARD_DELIVERIES = ["each", "digest"] as const;
export type ForwardDelivery = (typeof FORWARD_DELIVERIES)[number];
export const MIN_DIGEST_INTERVAL_MINUTES = 15;
export const MAX_DIGEST_INTERVAL_MINUTES = 10080;
export const DEFAULT_DIGEST_INTERVAL_MINUTES = 60;

/** Upper bound on to+cc+bcc for one forward channel. */
export const MAX_FORWARD_RECIPIENTS = 10;

export const DEFAULT_FORWARD_SUBJECT_TEMPLATE = "Fwd: {subject}";

/** Non-secret config for a "forward" channel. Addresses are stored lowercased. */
export interface ForwardChannelConfig {
  mode: ForwardMode;
  /** Default "each". "digest" can't be combined with mode "redirect" (a redirect is one original message, not a summary). */
  delivery?: ForwardDelivery;
  /** "digest" only. Default DEFAULT_DIGEST_INTERVAL_MINUTES. */
  digestIntervalMinutes?: number;
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** Display name on the From line; the address itself is always the SMTP sender (SPF). Defaults to the SMTP "from name". */
  fromName?: string;
  /** Where replies go. Default "original_sender". */
  replyTo?: ForwardReplyTo;
  /** Placeholders: {subject} {sender} {category} {destination}. Default DEFAULT_FORWARD_SUBJECT_TEMPLATE. Not used by "redirect", which keeps the original subject. */
  subjectTemplate?: string;
  /** "inline" only: re-attach the original's attachments. Default true. */
  includeAttachments?: boolean;
  /** Add Jev's analysis (spam score, category, urgency) to the cover note. Default true. Not used by "redirect". */
  includeAnalysis?: boolean;
}

export function forwardRecipientsOf(config: ForwardChannelConfig): string[] {
  return [...config.to, ...(config.cc ?? []), ...(config.bcc ?? [])];
}

/**
 * 1.2 (O): when a rule sends an email here, tell people — a short notice
 * (who wrote, about what, Jev's view, a link), not the email itself (that is
 * the forward channel). Recipients are organization members (picked, or
 * everyone holding a permission) and confirmed outside addresses; mailboxes
 * Eumaeus watches never get one (a notice would come back in as new mail).
 */
export const NOTIFY_DELIVERIES = ["each", "throttle", "digest"] as const;
export type NotifyDelivery = (typeof NOTIFY_DELIVERIES)[number];
export const MAX_NOTIFY_MEMBERS = 50;
export const MAX_NOTIFY_ADDRESSES = 10;
export const MIN_NOTIFY_THROTTLE_MINUTES = 15;
export const MAX_NOTIFY_THROTTLE_MINUTES = 1440;
export const DEFAULT_NOTIFY_THROTTLE_MINUTES = 60;
export const DEFAULT_NOTIFY_SUBJECT_TEMPLATE = "{destination}: {subject}";
export const NOTIFY_EXCERPT_CHARS = 500;
/** Placeholders a notice's subject and intro may use. */
export const NOTIFY_PLACEHOLDERS = ["subject", "sender", "sender_name", "mailbox", "category", "urgency", "spam", "destination"] as const;

export interface EmailNotifyChannelConfig {
  /** User ids of this organization's members. */
  members?: string[];
  /** Every active member holding this permission, e.g. "reviews:resolve". */
  permission?: string;
  /** Outside addresses; each must confirm (like forward recipients). Stored lowercased. */
  addresses?: string[];
  /** Default DEFAULT_NOTIFY_SUBJECT_TEMPLATE. */
  subjectTemplate?: string;
  /** A sentence or two above the email's details; same placeholders. Default: a localized "new email for {destination}". */
  intro?: string;
  /** Add the first NOTIFY_EXCERPT_CHARS characters of the text. Default false — a notice is not a copy. */
  includeExcerpt?: boolean;
  /** each (default): one notice per email. throttle: at most one per throttleMinutes, the rest summed up in the next. digest: one summary every digestIntervalMinutes. */
  delivery?: NotifyDelivery;
  throttleMinutes?: number;
  digestIntervalMinutes?: number;
}

/**
 * Phase 19: answers the sender with a fixed message. Never answers automated
 * mail (RFC 3834: Auto-Submitted, Precedence bulk/list, List-Id, no-reply
 * addresses), spam, or the same sender twice within cooldownDays.
 */
export interface AutoReplyChannelConfig {
  /** Placeholders: {subject} {sender} {sender_name} {category}. Default DEFAULT_AUTO_REPLY_SUBJECT. */
  subjectTemplate?: string;
  /** Plain text, same placeholders. */
  body: string;
  fromName?: string;
  /** Default 7. */
  cooldownDays?: number;
  /** Don't answer when Jev's spam score is at or above this. Default 0.5. */
  maxSpamScore?: number;
}
export const DEFAULT_AUTO_REPLY_SUBJECT = "Re: {subject}";
export const DEFAULT_AUTO_REPLY_COOLDOWN_DAYS = 7;
export const DEFAULT_AUTO_REPLY_MAX_SPAM = 0.5;

/** Phase 19: Slack / Teams incoming-webhook URL. The URL is a credential (whoever has it can post), so it's redacted like a webhook's. */
export interface ChatChannelConfig {
  url: string;
}

/** Phase 19: creates a Jira issue. The API token is a DestinationSecret named by secretName. */
export interface JiraChannelConfig {
  baseUrl: string;
  projectKey: string;
  issueType: string;
  accountEmail: string;
  secretName: string;
}

/** Phase 19: creates a Zendesk ticket. The API token is a DestinationSecret named by secretName. */
export interface ZendeskChannelConfig {
  subdomain: string;
  accountEmail: string;
  secretName: string;
  priority?: "low" | "normal" | "high" | "urgent";
}

export type ActionExecutionStatus = "pending" | "succeeded" | "failed" | "ambiguous";
