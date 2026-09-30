import type { Destination, DestinationChannel } from "@prisma/client";
import type { DestinationSecretMetadata } from "../../modules/destinations/manageSecrets.js";

export interface DestinationChannelResponse {
  id: string;
  type: string;
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** Phase 13.4: forward channels with delivery "digest" only, on the detail endpoint. */
  digest?: { pending: number; lastSentAt: string | null };
}

export interface DigestStatus {
  pending: number;
  lastSentAt: Date | null;
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

/**
 * Redacts a webhook URL to its origin only. Real-world incoming-webhook URLs
 * (Slack, Discord-style, many generic providers) embed a bearer-token-equivalent
 * directly in the URL PATH — returning the full URL through this API would leak
 * that credential to anyone who can read the Destination, which is exactly the
 * "webhook URL may be considered sensitive configuration" case the Phase 6 brief
 * calls out. Only the scheme+host survive; never the path or query string.
 */
function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "***";
  }
}

/** Explicit, type-aware config serialization — never a raw spread of the Prisma JSON column (§19: the serializer is a security boundary). */
function serializeChannelConfig(type: string, config: unknown): Record<string, unknown> {
  const value = (config ?? {}) as Record<string, unknown>;
  if (type === "webhook") {
    return {
      url: typeof value.url === "string" ? redactWebhookUrl(value.url) : null,
      secretName: typeof value.secretName === "string" ? value.secretName : null,
    };
  }
  if (type === "archive" || type === "flag") {
    return {
      ...(type === "archive" ? { folder: typeof value.folder === "string" ? value.folder : null } : {}),
      markSeen: value.markSeen === true,
      flagged: value.flagged === true,
      keywords: Array.isArray(value.keywords) ? value.keywords.filter((k): k is string => typeof k === "string") : [],
    };
  }
  if (type === "forward") {
    // Nothing secret in a forward config — addresses are shown so the form can be edited.
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      mode: typeof value.mode === "string" ? value.mode : null,
      delivery: value.delivery === "digest" ? "digest" : "each",
      digestIntervalMinutes: typeof value.digestIntervalMinutes === "number" ? value.digestIntervalMinutes : null,
      to: list(value.to),
      cc: list(value.cc),
      bcc: list(value.bcc),
      fromName: typeof value.fromName === "string" ? value.fromName : null,
      replyTo: typeof value.replyTo === "string" ? value.replyTo : "original_sender",
      subjectTemplate: typeof value.subjectTemplate === "string" ? value.subjectTemplate : null,
      includeAttachments: value.includeAttachments !== false,
      includeAnalysis: value.includeAnalysis !== false,
    };
  }
  if (type === "auto_reply") {
    return {
      subjectTemplate: typeof value.subjectTemplate === "string" ? value.subjectTemplate : null,
      body: typeof value.body === "string" ? value.body : "",
      fromName: typeof value.fromName === "string" ? value.fromName : null,
      cooldownDays: typeof value.cooldownDays === "number" ? value.cooldownDays : 7,
      maxSpamScore: typeof value.maxSpamScore === "number" ? value.maxSpamScore : 0.5,
    };
  }
  if (type === "slack" || type === "teams") {
    // An incoming-webhook URL is itself the credential: only its origin is shown.
    return { url: typeof value.url === "string" ? redactWebhookUrl(value.url) : null };
  }
  if (type === "jira") {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { baseUrl: str(value.baseUrl), projectKey: str(value.projectKey), issueType: str(value.issueType), accountEmail: str(value.accountEmail), secretName: str(value.secretName) };
  }
  if (type === "zendesk") {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { subdomain: str(value.subdomain), accountEmail: str(value.accountEmail), secretName: str(value.secretName), priority: str(value.priority) };
  }
  // An unrecognized channel type (should be unreachable — manageDestinations.ts
  // rejects anything not in SUPPORTED_CHANNEL_TYPES at save time) — fail closed
  // by exposing nothing rather than guessing which fields, if any, are safe.
  return {};
}

export function serializeDestinationChannel(row: DestinationChannel, digest?: DigestStatus): DestinationChannelResponse {
  return {
    ...(digest ? { digest: { pending: digest.pending, lastSentAt: digest.lastSentAt?.toISOString() ?? null } } : {}),
    id: row.id,
    type: row.type,
    version: row.version,
    enabled: row.enabled,
    config: serializeChannelConfig(row.type, row.config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  };
}

export function serializeDestination(row: Destination, channels: DestinationChannel[], digestByChannel?: Map<string, DigestStatus>): DestinationResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    channels: channels.map((channel) => serializeDestinationChannel(channel, digestByChannel?.get(channel.id))),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Never includes encryptedValue — DestinationSecretMetadata (manageSecrets.ts) structurally cannot carry it in the first place, but this serializer exists so the response shape is still owned here, not left as "whatever the domain type happens to expose." */
export function serializeDestinationSecret(metadata: DestinationSecretMetadata): DestinationSecretResponse {
  return {
    id: metadata.id,
    destinationId: metadata.destinationId,
    name: metadata.name,
    createdAt: metadata.createdAt.toISOString(),
    updatedAt: metadata.updatedAt.toISOString(),
  };
}
