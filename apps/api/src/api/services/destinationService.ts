import { prisma } from "../../db/client.js";
import {
  createDestination as domainCreateDestination,
  createDestinationChannel,
  updateDestinationChannel,
  disableDestinationChannel,
  updateDestinationMetadata,
  disableAllChannelsForDestination,
  validateChannelForTenant,
  flagArchiveConflict,
  DestinationValidationError,
} from "../../modules/destinations/manageDestinations.js";
import {
  setDestinationSecret,
  deleteDestinationSecret,
  listDestinationSecretMetadata,
  DestinationSecretError,
} from "../../modules/destinations/manageSecrets.js";
import { requestForwardRecipients } from "../../modules/destinations/forwardRecipients.js";
import { forwardRecipientsOf, type ForwardChannelConfig } from "../../modules/destinations/types.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { MAX_NESTED_ROWS, paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import {
  serializeDestination,
  serializeDestinationSecret,
  type DestinationResponse,
  type DestinationSecretResponse,
  type DigestStatus,
} from "../serializers/destinationSerializer.js";

async function loadChannelsForDestinations(destinationIds: string[]) {
  if (destinationIds.length === 0) return new Map<string, Awaited<ReturnType<typeof prisma.destinationChannel.findMany>>>();
  const channels = await prisma.destinationChannel.findMany({
    where: { destinationId: { in: destinationIds } },
    orderBy: { createdAt: "asc" },
    take: MAX_NESTED_ROWS,
  });
  const byDestination = new Map<string, typeof channels>();
  for (const channel of channels) {
    const bucket = byDestination.get(channel.destinationId) ?? [];
    bucket.push(channel);
    byDestination.set(channel.destinationId, bucket);
  }
  return byDestination;
}

export async function listDestinations(tenantId: string, query: PaginationQuery): Promise<CursorPage<DestinationResponse>> {
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.destination.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  const channelsByDestination = await loadChannelsForDestinations(page.data.map((d) => d.id));
  return { ...page, data: page.data.map((d) => serializeDestination(d, channelsByDestination.get(d.id) ?? [])) };
}

export async function getDestinationById(tenantId: string, id: string): Promise<DestinationResponse> {
  const destination = await prisma.destination.findFirst({ where: { id, tenantId } });
  if (!destination) throw new NotFoundError(`Destination ${id} not found`);
  const channels = await prisma.destinationChannel.findMany({ where: { destinationId: id }, orderBy: { createdAt: "asc" }, take: MAX_NESTED_ROWS });
  return serializeDestination(destination, channels, await loadDigestStatus(channels));
}

/** Phase 13.4: queued-email count and last successful send for each live digest channel. */
async function loadDigestStatus(channels: Array<{ id: string; type: string; config: unknown; enabled: boolean; deactivatedAt: Date | null }>): Promise<Map<string, DigestStatus>> {
  const digestIds = channels
    .filter((c) => c.type === "forward" && c.enabled && !c.deactivatedAt && (c.config as { delivery?: unknown } | null)?.delivery === "digest")
    .map((c) => c.id);
  const status = new Map<string, DigestStatus>();
  if (digestIds.length === 0) return status;
  const [pending, lastSent] = await Promise.all([
    prisma.forwardDigestItem.groupBy({ by: ["destinationChannelId"], where: { destinationChannelId: { in: digestIds }, status: "queued" }, _count: { _all: true } }),
    prisma.forwardDigestBatch.groupBy({ by: ["destinationChannelId"], where: { destinationChannelId: { in: digestIds }, status: "sent" }, _max: { completedAt: true } }),
  ]);
  for (const id of digestIds) status.set(id, { pending: 0, lastSentAt: null });
  for (const row of pending) status.get(row.destinationChannelId)!.pending = row._count._all;
  for (const row of lastSent) status.get(row.destinationChannelId)!.lastSentAt = row._max.completedAt;
  return status;
}

export interface CreateDestinationInput {
  name: string;
  description?: string;
  channels?: Array<{ type: string; config: Record<string, unknown> }>;
}

/**
 * Composes the two existing domain functions (createDestination,
 * createDestinationChannel) rather than a new parallel creation path. Every
 * channel is validated up front (0.13.1), so an invalid channel rejects the
 * request before the Destination row exists. Not one DB transaction: a
 * failure AFTER validation (a database error mid-way) could still leave a
 * partial result — the same database-level caveat as before, now limited to
 * genuine infrastructure errors.
 */
/** A saved forward channel's addresses become (pending) forward recipients, each sent a confirmation link — see modules/destinations/forwardRecipients.ts. */
async function registerForwardRecipients(tenantId: string, channel: { type: string; config: unknown }, actor: string | undefined): Promise<void> {
  if (channel.type === "forward") await requestForwardRecipients(tenantId, forwardRecipientsOf(channel.config as ForwardChannelConfig), actor);
  // 1.2 (O): outside addresses of a notify channel confirm the same way.
  const outside = channel.type === "email_notify" ? ((channel.config as { addresses?: string[] }).addresses ?? []) : [];
  if (outside.length > 0) await requestForwardRecipients(tenantId, outside, actor);
}

export async function createDestination(tenantId: string, input: CreateDestinationInput, actor?: string): Promise<DestinationResponse> {
  // Validate every requested channel first: an invalid channel rejects the
  // whole request and nothing is created (previously the destination was
  // created and left without that channel).
  const channelErrors: string[] = [];
  for (const [index, channel] of (input.channels ?? []).entries()) {
    const errors = await validateChannelForTenant(tenantId, { type: channel.type, config: channel.config as never as object });
    channelErrors.push(...errors.map((e) => ((input.channels?.length ?? 0) > 1 ? `channel ${index + 1}: ${e}` : e)));
  }
  channelErrors.push(...flagArchiveConflict((input.channels ?? []).map((c) => c.type)));
  if (channelErrors.length > 0) throw new ValidationError(`Invalid destination configuration: ${channelErrors.join("; ")}`, channelErrors);

  let destination;
  try {
    destination = await domainCreateDestination(tenantId, { name: input.name, description: input.description });
  } catch (error) {
    if (error instanceof DestinationValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }

  const createdChannels = [];
  try {
    for (const channel of input.channels ?? []) {
      const created = await createDestinationChannel(tenantId, destination.id, { type: channel.type, config: channel.config as never as object });
      createdChannels.push(created);
      await registerForwardRecipients(tenantId, created, actor);
    }
  } catch (error) {
    if (error instanceof DestinationValidationError) {
      throw new ValidationError(
        `Destination "${destination.name}" was created, but a requested channel was invalid: ${error.message}`,
        error.errors,
      );
    }
    throw error;
  }

  return serializeDestination(destination, createdChannels);
}

export async function updateDestination(
  tenantId: string,
  id: string,
  input: { name?: string; description?: string },
): Promise<DestinationResponse> {
  let updated;
  try {
    updated = await updateDestinationMetadata(tenantId, id, input);
  } catch (error) {
    if (error instanceof DestinationValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
  if (!updated) throw new NotFoundError(`Destination ${id} not found`);
  const channels = await prisma.destinationChannel.findMany({ where: { destinationId: id }, orderBy: { createdAt: "asc" }, take: MAX_NESTED_ROWS });
  return serializeDestination(updated, channels);
}

export async function deleteDestination(tenantId: string, id: string): Promise<void> {
  const disabled = await disableAllChannelsForDestination(tenantId, id);
  if (!disabled) throw new NotFoundError(`Destination ${id} not found`);
}

// --- Channels on an existing destination. updateDestinationChannel /
// disableDestinationChannel take a bare channel id with no tenant scoping of
// their own, so ownership (this tenant, this destination, still live) is
// checked HERE before either is called — a channel id from another tenant or
// another destination is a 404, never silently edited. ---

async function requireLiveChannel(tenantId: string, destinationId: string, channelId: string) {
  const channel = await prisma.destinationChannel.findFirst({ where: { id: channelId, tenantId, destinationId, deactivatedAt: null } });
  if (!channel) throw new NotFoundError(`Channel ${channelId} not found on this destination`);
  return channel;
}

export async function addChannel(
  tenantId: string,
  destinationId: string,
  input: { type: string; config: Record<string, unknown> },
  actor?: string,
): Promise<DestinationResponse> {
  let created;
  try {
    created = await createDestinationChannel(tenantId, destinationId, { type: input.type, config: input.config as never as object });
  } catch (error) {
    if (error instanceof DestinationValidationError) {
      // createDestinationChannel reports a missing destination as a validation error; surface that as the 404 it really is.
      if (error.errors.some((e) => e.startsWith("no destination"))) throw new NotFoundError(`Destination ${destinationId} not found`);
      throw new ValidationError(error.message, error.errors);
    }
    throw error;
  }
  await registerForwardRecipients(tenantId, created, actor);
  return getDestinationById(tenantId, destinationId);
}

/** A new channel VERSION (the old row is deactivated, never mutated) — see updateDestinationChannel. The type can't change on edit; replace the channel instead. */
export async function editChannel(
  tenantId: string,
  destinationId: string,
  channelId: string,
  config: Record<string, unknown>,
  actor?: string,
): Promise<DestinationResponse> {
  const existing = await requireLiveChannel(tenantId, destinationId, channelId);
  let updated;
  try {
    updated = await updateDestinationChannel(channelId, { type: existing.type, config: config as never as object });
  } catch (error) {
    if (error instanceof DestinationValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
  await registerForwardRecipients(tenantId, updated, actor);
  return getDestinationById(tenantId, destinationId);
}

export async function disableChannel(tenantId: string, destinationId: string, channelId: string): Promise<DestinationResponse> {
  await requireLiveChannel(tenantId, destinationId, channelId);
  await disableDestinationChannel(channelId);
  return getDestinationById(tenantId, destinationId);
}

// --- Destination secrets: thin wrappers over manageSecrets.ts, reusing it
// directly rather than a second encryption/storage path (§9). ---

export async function listDestinationSecrets(tenantId: string, destinationId: string): Promise<DestinationSecretResponse[]> {
  const destination = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!destination) throw new NotFoundError(`Destination ${destinationId} not found`);
  const metadata = await listDestinationSecretMetadata(tenantId, destinationId);
  return metadata.map(serializeDestinationSecret);
}

export async function putDestinationSecret(
  tenantId: string,
  destinationId: string,
  name: string,
  value: string,
): Promise<DestinationSecretResponse> {
  try {
    const metadata = await setDestinationSecret(tenantId, destinationId, name, value);
    return serializeDestinationSecret(metadata);
  } catch (error) {
    if (error instanceof DestinationSecretError) throw new NotFoundError(error.message);
    throw error;
  }
}

export async function removeDestinationSecret(tenantId: string, destinationId: string, name: string): Promise<void> {
  const destination = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!destination) throw new NotFoundError(`Destination ${destinationId} not found`);
  const existing = await prisma.destinationSecret.findFirst({ where: { tenantId, destinationId, name } });
  if (!existing) throw new NotFoundError(`No secret named "${name}" is configured for destination "${destinationId}"`);
  await deleteDestinationSecret(tenantId, destinationId, name);
}
