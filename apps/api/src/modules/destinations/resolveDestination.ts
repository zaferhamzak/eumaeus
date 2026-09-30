import type { Destination, DestinationChannel } from "@prisma/client";
import { prisma } from "../../db/client.js";

export interface ResolvedDestination {
  destination: Destination;
  /** Enabled, non-deactivated channels only — a disabled/deactivated channel is invisible to resolution, never a candidate for execution. */
  channels: DestinationChannel[];
}

/**
 * Tenant-scoped lookup: destinationRef (a Rule's plain string label) -> the
 * Destination it names, for THIS tenant, plus its currently-enabled channels.
 *
 * This is the single most security-critical function in Phase 5A
 * (phase5-destinations-architecture.md Revision 2 §17): `tenantId` is the trust
 * boundary. There is no code path here that can resolve a destination belonging to
 * a different tenant, because the Prisma query itself is filtered by tenantId — not
 * because the caller is trusted to have already checked.
 *
 * Returns null if no Destination with that name exists for this tenant, OR if it
 * exists but has zero enabled channels (both cases are indistinguishable to the
 * caller on purpose — either way there is nothing to execute against).
 */
export async function resolveDestination(tenantId: string, destinationRef: string): Promise<ResolvedDestination | null> {
  const destination = await prisma.destination.findFirst({
    where: { tenantId, name: destinationRef },
  });
  if (!destination) return null;

  const channels = await prisma.destinationChannel.findMany({
    where: { tenantId, destinationId: destination.id, enabled: true, deactivatedAt: null },
  });
  if (channels.length === 0) return null;

  return { destination, channels };
}

/**
 * Loads one specific, already-resolved channel by id, tenant-scoped — used by
 * executeAction.ts at execution time to re-check the channel is still enabled
 * (config can change between dispatch-time resolution and the job actually
 * running; see this file's test coverage for the "config changed mid-flight"
 * case). Returns null if the channel doesn't exist, belongs to a different
 * tenant, or is no longer enabled.
 */
export async function loadEnabledChannel(tenantId: string, destinationChannelId: string): Promise<DestinationChannel | null> {
  return prisma.destinationChannel.findFirst({
    where: { id: destinationChannelId, tenantId, enabled: true, deactivatedAt: null },
  });
}
