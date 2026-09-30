import type { Destination, DestinationChannel, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { isPermission } from "../auth/permissions.js";
import {
  FORWARD_DELIVERIES,
  FORWARD_MODES,
  MAX_DIGEST_INTERVAL_MINUTES,
  MAX_FLAG_KEYWORDS,
  MIN_DIGEST_INTERVAL_MINUTES,
  type ImapFlagOptions,
  FORWARD_REPLY_TO_OPTIONS,
  MAX_FORWARD_RECIPIENTS,
  forwardRecipientsOf,
  NOTIFY_DELIVERIES,
  MAX_NOTIFY_MEMBERS,
  MAX_NOTIFY_ADDRESSES,
  MIN_NOTIFY_THROTTLE_MINUTES,
  MAX_NOTIFY_THROTTLE_MINUTES,
  type EmailNotifyChannelConfig,
  type NotifyDelivery,
  isSupportedChannelType,
  RESERVED_HUMAN_REVIEW_DESTINATION_REF,
  SUPPORTED_CHANNEL_TYPES,
  type ForwardChannelConfig,
} from "./types.js";

export class DestinationValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid destination configuration: ${errors.join("; ")}`);
    this.name = "DestinationValidationError";
  }
}

/**
 * No HTTP/management UI or API in Phase 5A (out of scope) — these are the
 * functions such a UI (or a seed script, or a test) calls directly, mirroring
 * modules/rules/manageRules.ts's shape exactly.
 */
/** Phase 6: the Control Plane API's PATCH /destinations/:id — metadata only (name/description). Never touches channels; see manageDestinations.ts's own channel functions for that, and api/services/destinationService.ts for why the API deliberately doesn't expose nested channel edits through this call. */
export async function updateDestinationMetadata(
  tenantId: string,
  destinationId: string,
  input: { name?: string; description?: string },
): Promise<Destination | null> {
  const existing = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!existing) return null;

  const errors: string[] = [];
  if (input.name !== undefined) {
    if (!input.name.trim()) errors.push("name must not be empty");
    if (input.name === RESERVED_HUMAN_REVIEW_DESTINATION_REF) {
      errors.push(`name "${RESERVED_HUMAN_REVIEW_DESTINATION_REF}" is reserved and cannot be used for a configured Destination`);
    }
  }
  if (errors.length > 0) throw new DestinationValidationError(errors);

  try {
    return await prisma.destination.update({
      where: { id: destinationId },
      data: { name: input.name, description: input.description },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new DestinationValidationError([`a destination named "${input.name}" already exists for this tenant`]);
    }
    throw error;
  }
}

/**
 * Phase 6: the Control Plane API's DELETE /destinations/:id. Destination rows
 * are referenced by DestinationChannel/ActionExecution history (ON DELETE
 * RESTRICT) and must never actually be dropped — this is the same "soft
 * disable, never hard-delete history" pattern already established for Rule
 * (deactivation) and DestinationChannel (versioned edits never destroy a prior
 * row). Disables every current channel; the Destination row itself, and its
 * name, remain in place (so a routingRef pointing at it now correctly resolves
 * to "no enabled channels," the same as any other disabled destination — see
 * resolveDestination.ts).
 */
export async function disableAllChannelsForDestination(tenantId: string, destinationId: string): Promise<boolean> {
  const existing = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!existing) return false;

  await prisma.destinationChannel.updateMany({
    where: { destinationId, tenantId, enabled: true },
    data: { enabled: false, deactivatedAt: new Date() },
  });
  return true;
}

export async function createDestination(tenantId: string, input: { name: string; description?: string }): Promise<Destination> {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("name must not be empty");
  if (input.name === RESERVED_HUMAN_REVIEW_DESTINATION_REF) {
    errors.push(`name "${RESERVED_HUMAN_REVIEW_DESTINATION_REF}" is reserved and cannot be used for a configured Destination`);
  }
  if (errors.length > 0) throw new DestinationValidationError(errors);

  try {
    return await prisma.destination.create({ data: { tenantId, name: input.name, description: input.description } });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new DestinationValidationError([`a destination named "${input.name}" already exists for this tenant`]);
    }
    throw error;
  }
}

export interface CreateChannelInput {
  type: string;
  config: Prisma.InputJsonValue;
}

/**
 * Everything createDestinationChannel would reject, without writing anything
 * — lets a caller creating a destination together with its channels check
 * all channels BEFORE creating the destination (0.13.1: an invalid channel
 * must not leave an empty destination behind).
 */
export async function validateChannelForTenant(tenantId: string, input: CreateChannelInput): Promise<string[]> {
  const { errors, config } = validateChannelInput(input);
  if (errors.length === 0) errors.push(...(await outgoingPolicyErrors(tenantId, input.type, config)));
  return errors;
}

/**
 * The organization-level rules for channels that send mail, checked at save
 * time (and again at send time): forward recipients; for "email_notify" (1.2)
 * its outside addresses by the same rules, and its members must belong here.
 */
async function outgoingPolicyErrors(tenantId: string, type: string, config: unknown): Promise<string[]> {
  if (type === "forward") return checkForwardPolicy(tenantId, config as ForwardChannelConfig);
  if (type !== "email_notify") return [];
  const notify = config as EmailNotifyChannelConfig;
  const errors = notify.addresses?.length ? await checkForwardPolicy(tenantId, { to: notify.addresses } as ForwardChannelConfig) : [];
  if (notify.members?.length) {
    const found = await prisma.membership.findMany({ where: { tenantId, userId: { in: notify.members }, status: "active" }, select: { userId: true } });
    const known = new Set(found.map((m) => m.userId));
    for (const id of notify.members) if (!known.has(id)) errors.push(`"email_notify" channel member "${id}" is not an active member of this organization`);
  }
  return errors;
}

/**
 * Versioning (matches Rule's exact edit = new-row-old-deactivated pattern, per
 * phase5-destinations-architecture.md Revision 2 §9): a channel's config is never
 * mutated in place. This function only ever CREATES version 1 — see updateDestinationChannel
 * for edits.
 */
export async function createDestinationChannel(
  tenantId: string,
  destinationId: string,
  input: CreateChannelInput,
): Promise<DestinationChannel> {
  const { errors, config } = validateChannelInput(input);
  const destination = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!destination) errors.push(`no destination "${destinationId}" exists for this tenant`);
  if (destination && errors.length === 0) {
    const live = await prisma.destinationChannel.findMany({ where: { destinationId, enabled: true, deactivatedAt: null }, select: { type: true } });
    errors.push(...flagArchiveConflict([...live.map((c) => c.type), input.type]));
  }
  if (errors.length === 0) errors.push(...(await outgoingPolicyErrors(tenantId, input.type, config)));
  if (errors.length > 0) throw new DestinationValidationError(errors);

  return prisma.destinationChannel.create({
    data: {
      tenantId,
      destinationId,
      type: input.type,
      config,
      enabled: true,
      version: 1,
    },
  });
}

/**
 * Edit = new row, old row deactivated, in one transaction — so no ActionExecution
 * ever ends up pointing at a channel row whose config changed after the fact (see
 * test coverage: "config changed mid-flight, old execution provenance intact").
 */
export async function updateDestinationChannel(channelId: string, input: CreateChannelInput): Promise<DestinationChannel> {
  const { errors, config } = validateChannelInput(input);
  if (errors.length === 0 && (input.type === "forward" || input.type === "email_notify")) {
    const current = await prisma.destinationChannel.findUniqueOrThrow({ where: { id: channelId } });
    errors.push(...(await outgoingPolicyErrors(current.tenantId, input.type, config)));
  }
  if (errors.length > 0) throw new DestinationValidationError(errors);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.destinationChannel.findUniqueOrThrow({ where: { id: channelId } });

    await tx.destinationChannel.update({
      where: { id: channelId },
      data: { enabled: false, deactivatedAt: new Date() },
    });

    const created = await tx.destinationChannel.create({
      data: {
        tenantId: existing.tenantId,
        destinationId: existing.destinationId,
        type: input.type,
        config,
        enabled: true,
        version: existing.version + 1,
      },
    });
    // 1.2 (O): an edited notify channel keeps its queued notices and its throttle clock.
    if (existing.type === "email_notify" && input.type === "email_notify") {
      await tx.notifyQueueItem.updateMany({ where: { destinationChannelId: channelId }, data: { destinationChannelId: created.id } });
      const state = await tx.notifyChannelState.findUnique({ where: { destinationChannelId: channelId } });
      if (state) {
        await tx.notifyChannelState.delete({ where: { destinationChannelId: channelId } });
        await tx.notifyChannelState.create({ data: { destinationChannelId: created.id, tenantId: state.tenantId, lastSentAt: state.lastSentAt } });
      }
    }
    // Phase 13.4: emails waiting in this channel's digest move with it to the
    // new version — editing a channel must not silently drop queued mail.
    await tx.forwardDigestItem.updateMany({ where: { destinationChannelId: channelId, status: "queued" }, data: { destinationChannelId: created.id } });
    return created;
  });
}

/** Soft-disables ONE channel (same convention as disableAllChannelsForDestination — never a hard delete, past ActionExecutions keep pointing at it). Idempotent. */
export async function disableDestinationChannel(channelId: string): Promise<DestinationChannel> {
  return prisma.destinationChannel.update({
    where: { id: channelId },
    data: { enabled: false, deactivatedAt: new Date() },
  });
}

/**
 * Returns the config to store alongside any errors — identical to the input
 * for archive/webhook; for "forward" a normalized copy (addresses trimmed and
 * lowercased, defaults left implicit) so the executor and the recipient
 * verification list always compare like with like.
 */
function validateChannelInput(input: CreateChannelInput): { errors: string[]; config: Prisma.InputJsonValue } {
  const errors: string[] = [];
  if (!isSupportedChannelType(input.type)) {
    errors.push(`channel type "${input.type}" is not supported in this phase (supported: ${SUPPORTED_CHANNEL_TYPES.join(", ")})`);
    return { errors, config: input.config };
  }
  if (input.type === "forward") {
    const forward = validateForwardConfig(input.config);
    return { errors: forward.errors, config: forward.config as unknown as Prisma.InputJsonValue };
  }
  if (input.type === "archive") {
    const config = (input.config ?? {}) as Record<string, unknown>;
    if (typeof config.folder !== "string" || config.folder.trim() === "") {
      errors.push('"archive" channel config requires a non-empty "folder" string');
    }
    const flags = validateFlagOptions("archive", config, ["folder"]);
    errors.push(...flags.errors);
    return { errors, config: { folder: typeof config.folder === "string" ? config.folder.trim() : config.folder, ...flags.options } as Prisma.InputJsonValue };
  }
  if (input.type === "auto_reply") return validateAutoReplyConfig(input.config);
  if (input.type === "email_notify") return validateEmailNotifyConfig(input.config);
  if (input.type === "slack" || input.type === "teams") return validateChatConfig(input.type, input.config);
  if (input.type === "jira") return validateJiraConfig(input.config);
  if (input.type === "zendesk") return validateZendeskConfig(input.config);
  if (input.type === "flag") {
    const flags = validateFlagOptions("flag", (input.config ?? {}) as Record<string, unknown>, []);
    if (flags.errors.length === 0 && !flags.options.markSeen && !flags.options.flagged && !(flags.options.keywords?.length)) {
      flags.errors.push('"flag" channel must set at least one of "markSeen", "flagged" or "keywords"');
    }
    return { errors: flags.errors, config: flags.options as Prisma.InputJsonValue };
  }
  if (input.type === "webhook") {
    const config = input.config as { url?: unknown; secretName?: unknown };
    if (typeof config.url !== "string" || config.url.trim() === "") {
      errors.push('"webhook" channel config requires a non-empty "url" string');
    } else {
      // Save-time validation only checks the URL is well-formed and uses an
      // allowed protocol. Full SSRF validation (DNS resolution, private-range
      // checks) deliberately happens at EXECUTION time
      // (executors/ssrf.ts) — a hostname's DNS record can change between when
      // a destination is configured and when it's actually used, so a
      // save-time-only check would be both insufficient and stale.
      try {
        const parsed = new URL(config.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push(`"webhook" channel "url" must use http or https, got "${parsed.protocol}"`);
        }
      } catch {
        errors.push('"webhook" channel "url" is not a valid URL');
      }
    }
    if (config.secretName !== undefined && (typeof config.secretName !== "string" || config.secretName.trim() === "")) {
      errors.push('"webhook" channel "secretName", if set, must be a non-empty string');
    }
  }
  return { errors, config: input.config };
}

/**
 * Phase 15. A keyword must be a single token: IMAP keywords can't contain
 * spaces or IMAP specials, and can't start with "\\" (reserved for system
 * flags). Gmail labels would allow more, but the channel doesn't know the
 * server at save time, so the portable rule applies everywhere.
 */
const KEYWORD_PATTERN = /^[^\s(){%*"\\\]][^\s(){%*"\\\]]{0,63}$/u;

function validateFlagOptions(type: string, input: Record<string, unknown>, extraKeys: string[]): { errors: string[]; options: ImapFlagOptions } {
  const errors: string[] = [];
  const options: ImapFlagOptions = {};
  for (const flag of ["markSeen", "flagged"] as const) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== "boolean") errors.push(`"${type}" channel "${flag}" must be a boolean`);
    else if (input[flag]) options[flag] = true;
  }
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) {
      errors.push(`"${type}" channel "keywords" must be an array of strings`);
    } else {
      const keywords = input.keywords.map((k) => (typeof k === "string" ? k.trim() : k));
      if (keywords.length > MAX_FLAG_KEYWORDS) errors.push(`"${type}" channel allows at most ${MAX_FLAG_KEYWORDS} keywords`);
      for (const k of keywords) {
        if (typeof k !== "string" || !KEYWORD_PATTERN.test(k)) errors.push(`"${type}" channel keyword ${JSON.stringify(k)} is not valid: use a single word without spaces or ( ) { } % * " \\ ]`);
      }
      const unique = [...new Set(keywords.filter((k): k is string => typeof k === "string"))];
      if (unique.length > 0) options.keywords = unique;
    }
  }
  const known = new Set(["markSeen", "flagged", "keywords", ...extraKeys]);
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push(`"${type}" channel has an unknown setting "${key}"`);
  return { errors, options };
}

/**
 * Phase 15: a destination can't have both a live "flag" and a live "archive"
 * channel. Channels run in parallel, so a separate flag STORE would race the
 * move (and usually lose — the message is gone from the folder). The archive
 * channel sets the same flags itself, before moving.
 */
export function flagArchiveConflict(types: string[]): string[] {
  return types.includes("flag") && types.includes("archive")
    ? ['a destination cannot have both a "flag" and an "archive" channel — set the flags on the archive channel instead (they are applied just before the move)']
    : [];
}

/** Phase 19 validators. Each returns the normalized config to store, like validateForwardConfig. */
function unknownKeys(type: string, input: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(input).filter((k) => !known.includes(k)).map((k) => `"${type}" channel has an unknown setting "${k}"`);
}

function singleLine(type: string, input: Record<string, unknown>, field: string, max: number, required: boolean, errors: string[]): string | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`"${type}" channel needs "${field}"`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) {
    errors.push(`"${type}" channel "${field}" must be a single line of at most ${max} characters`);
    return undefined;
  }
  return value.trim();
}

function validateAutoReplyConfig(raw: unknown): { errors: string[]; config: Prisma.InputJsonValue } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors = unknownKeys("auto_reply", input, ["subjectTemplate", "body", "fromName", "cooldownDays", "maxSpamScore"]);
  const subjectTemplate = singleLine("auto_reply", input, "subjectTemplate", 200, false, errors);
  const fromName = singleLine("auto_reply", input, "fromName", 100, false, errors);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) errors.push('"auto_reply" channel needs a "body"');
  else if (body.length > 5000) errors.push('"auto_reply" channel "body" can be at most 5000 characters');
  const cooldown = input.cooldownDays;
  if (cooldown !== undefined && (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 1 || cooldown > 90)) errors.push('"auto_reply" channel "cooldownDays" must be a whole number from 1 to 90');
  const maxSpam = input.maxSpamScore;
  if (maxSpam !== undefined && (typeof maxSpam !== "number" || maxSpam <= 0 || maxSpam > 1)) errors.push('"auto_reply" channel "maxSpamScore" must be above 0 and at most 1');
  return {
    errors,
    config: {
      body,
      ...(subjectTemplate ? { subjectTemplate } : {}),
      ...(fromName ? { fromName } : {}),
      ...(typeof cooldown === "number" ? { cooldownDays: cooldown } : {}),
      ...(typeof maxSpam === "number" ? { maxSpamScore: maxSpam } : {}),
    },
  };
}

function httpsUrl(type: string, field: string, value: unknown, errors: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`"${type}" channel needs "${field}"`);
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") errors.push(`"${type}" channel "${field}" must be an https URL`);
    return url.toString().replace(/\/$/, "");
  } catch {
    errors.push(`"${type}" channel "${field}" is not a valid URL`);
    return undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1.2 (O). Save-time shape checks; who is actually reachable is decided at send time (notify.ts). */
export function validateEmailNotifyConfig(raw: unknown): { errors: string[]; config: Prisma.InputJsonValue } {
  const T = "email_notify";
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors = unknownKeys(T, input, ["members", "permission", "addresses", "subjectTemplate", "intro", "includeExcerpt", "delivery", "throttleMinutes", "digestIntervalMinutes"]);
  const config: EmailNotifyChannelConfig = {};

  if (input.members !== undefined) {
    if (!Array.isArray(input.members) || !input.members.every((m) => typeof m === "string" && UUID_PATTERN.test(m))) errors.push(`"${T}" channel "members" must be a list of user ids`);
    else if (input.members.length > MAX_NOTIFY_MEMBERS) errors.push(`"${T}" channel can notify at most ${MAX_NOTIFY_MEMBERS} members`);
    else if (input.members.length > 0) config.members = [...new Set(input.members as string[])];
  }
  if (input.permission !== undefined && input.permission !== null && input.permission !== "") {
    if (typeof input.permission !== "string" || !isPermission(input.permission)) errors.push(`"${T}" channel "permission" must be one of the permission names (e.g. "reviews:resolve")`);
    else config.permission = input.permission;
  }
  if (input.addresses !== undefined) {
    if (!Array.isArray(input.addresses) || !input.addresses.every((a) => typeof a === "string")) errors.push(`"${T}" channel "addresses" must be a list of email addresses`);
    else {
      const addresses = [...new Set((input.addresses as string[]).map((a) => a.trim().toLowerCase()).filter(Boolean))];
      for (const a of addresses) if (!EMAIL_PATTERN.test(a)) errors.push(`"${T}" channel address "${a}" is not a valid email address`);
      if (addresses.length > MAX_NOTIFY_ADDRESSES) errors.push(`"${T}" channel allows at most ${MAX_NOTIFY_ADDRESSES} outside addresses`);
      if (addresses.length > 0) config.addresses = addresses;
    }
  }
  if (!config.members && !config.permission && !config.addresses) errors.push(`"${T}" channel needs someone to notify: "members", "permission" or "addresses"`);

  const subjectTemplate = singleLine(T, input, "subjectTemplate", 200, false, errors);
  if (subjectTemplate) config.subjectTemplate = subjectTemplate;
  if (input.intro !== undefined && input.intro !== null && input.intro !== "") {
    if (typeof input.intro !== "string" || input.intro.length > 1000) errors.push(`"${T}" channel "intro" must be text of at most 1000 characters`);
    else config.intro = input.intro.trim();
  }
  if (input.includeExcerpt !== undefined) {
    if (typeof input.includeExcerpt !== "boolean") errors.push(`"${T}" channel "includeExcerpt" must be a boolean`);
    else if (input.includeExcerpt) config.includeExcerpt = true;
  }
  const delivery = input.delivery ?? "each";
  if (typeof delivery !== "string" || !(NOTIFY_DELIVERIES as readonly string[]).includes(delivery)) errors.push(`"${T}" channel "delivery" must be one of ${NOTIFY_DELIVERIES.join(", ")}`);
  else if (delivery !== "each") config.delivery = delivery as NotifyDelivery;
  const minutes = (field: "throttleMinutes" | "digestIntervalMinutes", min: number, max: number) => {
    const v = input[field];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors.push(`"${T}" channel "${field}" must be a whole number of minutes from ${min} to ${max}`);
    else config[field] = v;
  };
  if (delivery === "throttle") minutes("throttleMinutes", MIN_NOTIFY_THROTTLE_MINUTES, MAX_NOTIFY_THROTTLE_MINUTES);
  else if (input.throttleMinutes !== undefined) errors.push(`"${T}" channel "throttleMinutes" only applies to delivery "throttle"`);
  if (delivery === "digest") minutes("digestIntervalMinutes", MIN_DIGEST_INTERVAL_MINUTES, MAX_DIGEST_INTERVAL_MINUTES);
  else if (input.digestIntervalMinutes !== undefined) errors.push(`"${T}" channel "digestIntervalMinutes" only applies to delivery "digest"`);

  return { errors, config: config as unknown as Prisma.InputJsonValue };
}

function validateChatConfig(type: "slack" | "teams", raw: unknown): { errors: string[]; config: Prisma.InputJsonValue } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors = unknownKeys(type, input, ["url"]);
  const url = httpsUrl(type, "url", input.url, errors);
  return { errors, config: { url: url ?? "" } };
}

function validateJiraConfig(raw: unknown): { errors: string[]; config: Prisma.InputJsonValue } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors = unknownKeys("jira", input, ["baseUrl", "projectKey", "issueType", "accountEmail", "secretName"]);
  const baseUrl = httpsUrl("jira", "baseUrl", input.baseUrl, errors);
  const projectKey = singleLine("jira", input, "projectKey", 20, true, errors);
  if (projectKey && !/^[A-Z][A-Z0-9_]{0,19}$/.test(projectKey)) errors.push('"jira" channel "projectKey" looks like SUP or OPS (capital letters and digits)');
  const issueType = singleLine("jira", input, "issueType", 60, false, errors) ?? "Task";
  const accountEmail = singleLine("jira", input, "accountEmail", 254, true, errors);
  if (accountEmail && !EMAIL_PATTERN.test(accountEmail.toLowerCase())) errors.push('"jira" channel "accountEmail" is not an email address');
  const secretName = singleLine("jira", input, "secretName", 100, true, errors);
  return { errors, config: { baseUrl: baseUrl ?? "", projectKey: projectKey ?? "", issueType, accountEmail: accountEmail?.toLowerCase() ?? "", secretName: secretName ?? "" } };
}

function validateZendeskConfig(raw: unknown): { errors: string[]; config: Prisma.InputJsonValue } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors = unknownKeys("zendesk", input, ["subdomain", "accountEmail", "secretName", "priority"]);
  const subdomain = singleLine("zendesk", input, "subdomain", 63, true, errors)?.toLowerCase();
  if (subdomain && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) errors.push('"zendesk" channel "subdomain" is the part before .zendesk.com, e.g. "acme"');
  const accountEmail = singleLine("zendesk", input, "accountEmail", 254, true, errors);
  if (accountEmail && !EMAIL_PATTERN.test(accountEmail.toLowerCase())) errors.push('"zendesk" channel "accountEmail" is not an email address');
  const secretName = singleLine("zendesk", input, "secretName", 100, true, errors);
  const priority = input.priority;
  if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(priority))) errors.push('"zendesk" channel "priority" must be low, normal, high or urgent');
  return {
    errors,
    config: { subdomain: subdomain ?? "", accountEmail: accountEmail?.toLowerCase() ?? "", secretName: secretName ?? "", ...(priority ? { priority: String(priority) } : {}) },
  };
}

const EMAIL_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function validateForwardConfig(raw: unknown): { errors: string[]; config: ForwardChannelConfig } {
  const errors: string[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;

  const mode = input.mode;
  if (typeof mode !== "string" || !(FORWARD_MODES as readonly string[]).includes(mode)) {
    errors.push(`"forward" channel "mode" must be one of: ${FORWARD_MODES.join(", ")}`);
  }

  const addressList = (field: "to" | "cc" | "bcc", required: boolean): string[] => {
    const value = input[field];
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || (required && value.length === 0)) {
      errors.push(`"forward" channel "${field}" must be ${required ? "a non-empty" : "an"} array of email addresses`);
      return [];
    }
    const out: string[] = [];
    for (const entry of value) {
      const address = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      if (!EMAIL_PATTERN.test(address)) errors.push(`"forward" channel "${field}" contains an invalid email address: ${JSON.stringify(entry)}`);
      else out.push(address);
    }
    return out;
  };
  const to = addressList("to", true);
  const cc = addressList("cc", false);
  const bcc = addressList("bcc", false);

  const all = [...to, ...cc, ...bcc];
  if (all.length > MAX_FORWARD_RECIPIENTS) errors.push(`"forward" channel allows at most ${MAX_FORWARD_RECIPIENTS} recipients in total`);
  if (new Set(all).size !== all.length) errors.push('"forward" channel lists the same address more than once');

  const optionalString = (field: string, max: number): string | undefined => {
    const value = input[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) {
      errors.push(`"forward" channel "${field}" must be a single-line string of at most ${max} characters`);
      return undefined;
    }
    return value.trim();
  };
  const fromName = optionalString("fromName", 100);
  const subjectTemplate = optionalString("subjectTemplate", 200);

  const delivery = input.delivery ?? "each";
  if (typeof delivery !== "string" || !(FORWARD_DELIVERIES as readonly string[]).includes(delivery)) {
    errors.push(`"forward" channel "delivery" must be one of: ${FORWARD_DELIVERIES.join(", ")}`);
  }
  if (delivery === "digest" && mode === "redirect") errors.push('"forward" channel cannot combine mode "redirect" with delivery "digest"');
  const interval = input.digestIntervalMinutes;
  if (interval !== undefined && (typeof interval !== "number" || !Number.isInteger(interval) || interval < MIN_DIGEST_INTERVAL_MINUTES || interval > MAX_DIGEST_INTERVAL_MINUTES)) {
    errors.push(`"forward" channel "digestIntervalMinutes" must be a whole number between ${MIN_DIGEST_INTERVAL_MINUTES} and ${MAX_DIGEST_INTERVAL_MINUTES}`);
  }

  const replyTo = input.replyTo;
  if (replyTo !== undefined && (typeof replyTo !== "string" || !(FORWARD_REPLY_TO_OPTIONS as readonly string[]).includes(replyTo))) {
    errors.push(`"forward" channel "replyTo" must be one of: ${FORWARD_REPLY_TO_OPTIONS.join(", ")}`);
  }
  for (const flag of ["includeAttachments", "includeAnalysis"] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== "boolean") errors.push(`"forward" channel "${flag}" must be a boolean`);
  }

  const known = new Set(["mode", "delivery", "digestIntervalMinutes", "to", "cc", "bcc", "fromName", "replyTo", "subjectTemplate", "includeAttachments", "includeAnalysis"]);
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push(`"forward" channel has an unknown setting "${key}"`);

  const config: ForwardChannelConfig = {
    mode: mode as ForwardChannelConfig["mode"],
    ...(delivery === "digest" ? { delivery: "digest" as const, ...(typeof interval === "number" ? { digestIntervalMinutes: interval } : {}) } : {}),
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(fromName ? { fromName } : {}),
    ...(replyTo !== undefined ? { replyTo: replyTo as ForwardChannelConfig["replyTo"] } : {}),
    ...(subjectTemplate ? { subjectTemplate } : {}),
    ...(typeof input.includeAttachments === "boolean" ? { includeAttachments: input.includeAttachments } : {}),
    ...(typeof input.includeAnalysis === "boolean" ? { includeAnalysis: input.includeAnalysis } : {}),
  };
  return { errors, config };
}

/**
 * The organization-level rules a forward channel must satisfy at save time.
 * The executor re-checks the same rules at send time (settings can change in
 * between); this check exists so the mistake surfaces while someone is
 * looking at the form, not as a failed action days later.
 */
export async function checkForwardPolicy(tenantId: string, config: ForwardChannelConfig): Promise<string[]> {
  const errors: string[] = [];
  const recipients = forwardRecipientsOf(config);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { forwardAllowedDomains: true } });
  const allowed = (tenant?.forwardAllowedDomains ?? []).map((d) => d.toLowerCase());
  if (allowed.length > 0) {
    for (const address of recipients) {
      const domain = address.split("@")[1] ?? "";
      if (!allowed.includes(domain)) errors.push(`forwarding to "${address}" is not allowed — its domain is not on this organization's forwarding allowlist`);
    }
  }
  const monitored = await monitoredAddresses(tenantId);
  for (const address of recipients) {
    if (monitored.has(address)) errors.push(`"${address}" is a mailbox Eumaeus monitors for this organization — forwarding there would loop`);
  }
  return errors;
}

/** Lowercased addresses of every mailbox this tenant has connected (any status — a paused mailbox can be resumed). */
export async function monitoredAddresses(tenantId: string): Promise<Set<string>> {
  const mailboxes = await prisma.mailboxConnection.findMany({ where: { tenantId }, select: { emailAddress: true } });
  return new Set(mailboxes.map((m) => m.emailAddress?.toLowerCase()).filter((a): a is string => Boolean(a)));
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
