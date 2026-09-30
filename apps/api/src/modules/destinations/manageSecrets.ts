import { prisma } from "../../db/client.js";
import { encryptSecret, decryptSecret } from "../secrets/secretCrypto.js";

/**
 * Safe, plaintext-free view of a DestinationSecret — everything a management
 * caller (a future UI/API, a seed script, a test) should ever see. Deliberately
 * excludes encryptedValue: even the ciphertext has no reason to leave this module,
 * since nothing outside modules/destinations/executors/webhookExecutor.ts ever
 * needs it.
 */
export interface DestinationSecretMetadata {
  id: string;
  destinationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

function toMetadata(row: { id: string; destinationId: string; name: string; createdAt: Date; updatedAt: Date }): DestinationSecretMetadata {
  return { id: row.id, destinationId: row.destinationId, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export class DestinationSecretError extends Error {}

/**
 * Creates or replaces a destination secret by (destinationId, name) — deterministic
 * upsert, mirroring how a webhook config's `secretName` looks a secret up: by name,
 * scoped to the destination, never by a separately-tracked id a caller would have to
 * remember. Replacing an existing secret overwrites its encryptedValue outright —
 * the previous ciphertext is gone, and since it was never plaintext in the first
 * place, there is nothing to "expose" by deleting/replacing it.
 *
 * Returns metadata only — the plaintext passed in is never echoed back.
 */
export async function setDestinationSecret(
  tenantId: string,
  destinationId: string,
  name: string,
  plaintext: string,
): Promise<DestinationSecretMetadata> {
  if (!name.trim()) throw new DestinationSecretError("secret name must not be empty");
  if (!plaintext) throw new DestinationSecretError("secret value must not be empty");

  const destination = await prisma.destination.findFirst({ where: { id: destinationId, tenantId } });
  if (!destination) throw new DestinationSecretError(`no destination "${destinationId}" exists for this tenant`);

  const encryptedValue = encryptSecret(plaintext);

  const row = await prisma.destinationSecret.upsert({
    where: { destinationId_name: { destinationId, name } },
    create: { tenantId, destinationId, name, encryptedValue },
    update: { encryptedValue },
  });
  return toMetadata(row);
}

export async function deleteDestinationSecret(tenantId: string, destinationId: string, name: string): Promise<void> {
  await prisma.destinationSecret.deleteMany({ where: { tenantId, destinationId, name } });
}

// Defensive cap, not a real-world limit — a destination realistically has a
// handful of named secrets (e.g. one signing key per webhook channel).
const MAX_SECRETS_PER_DESTINATION = 200;

/** Safe listing — metadata only, for a future management UI/API. Never returns encryptedValue or plaintext. */
export async function listDestinationSecretMetadata(tenantId: string, destinationId: string): Promise<DestinationSecretMetadata[]> {
  const rows = await prisma.destinationSecret.findMany({
    where: { tenantId, destinationId },
    orderBy: { name: "asc" },
    take: MAX_SECRETS_PER_DESTINATION,
  });
  return rows.map(toMetadata);
}

/**
 * INTERNAL — resolves a secret's PLAINTEXT value. Called from exactly one place:
 * modules/destinations/executors/webhookExecutor.ts, immediately before signing a
 * request, and the returned string must never be retained, logged, or written to
 * any audit/response/error field beyond that single use. Every other function in
 * this module deliberately cannot do this.
 *
 * Deterministic, tenant-scoped lookup by (destinationId, name) — a missing secret
 * (never configured, wrong name, or belongs to a different tenant/destination) is a
 * single, deterministic configuration error, not several different failure shapes a
 * caller would have to distinguish.
 */
export async function resolveDestinationSecretPlaintext(tenantId: string, destinationId: string, name: string): Promise<string> {
  const row = await prisma.destinationSecret.findFirst({ where: { tenantId, destinationId, name } });
  if (!row) {
    throw new DestinationSecretError(`no secret named "${name}" is configured for destination "${destinationId}"`);
  }
  return decryptSecret(row.encryptedValue);
}
