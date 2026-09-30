import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { createDestination } from "../../src/modules/destinations/manageDestinations.js";
import {
  setDestinationSecret,
  deleteDestinationSecret,
  listDestinationSecretMetadata,
  resolveDestinationSecretPlaintext,
  DestinationSecretError,
} from "../../src/modules/destinations/manageSecrets.js";
import { resetDatabase } from "../helpers/db.js";

async function createTenant(name: string) {
  return prisma.tenant.create({ data: { name } });
}

describe("manageSecrets — destination-scoped secret management", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores a secret and returns safe metadata only — no plaintext, no ciphertext", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });

    const metadata = await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "correct-horse-battery-staple");

    expect(metadata).toMatchObject({ destinationId: destination.id, name: "webhook_signing_key" });
    expect(Object.keys(metadata).sort()).toEqual(["createdAt", "destinationId", "id", "name", "updatedAt"].sort());
    expect(JSON.stringify(metadata)).not.toContain("correct-horse-battery-staple");
  });

  it("resolves the exact plaintext at execution time", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "the-real-secret-value");

    const plaintext = await resolveDestinationSecretPlaintext(tenant.id, destination.id, "webhook_signing_key");
    expect(plaintext).toBe("the-real-secret-value");
  });

  it("the row actually persisted in the database never contains the plaintext", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "never-stored-in-the-clear");

    const row = await prisma.destinationSecret.findFirstOrThrow({ where: { destinationId: destination.id } });
    expect(row.encryptedValue).not.toContain("never-stored-in-the-clear");
  });

  it("a missing secret produces a deterministic configuration error, not a generic/undefined failure", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });

    await expect(resolveDestinationSecretPlaintext(tenant.id, destination.id, "does-not-exist")).rejects.toBeInstanceOf(
      DestinationSecretError,
    );
  });

  it("a secret cannot be resolved under a different tenant, even with the correct destinationId and name", async () => {
    const tenantA = await createTenant("Tenant A");
    const tenantB = await createTenant("Tenant B");
    const destination = await createDestination(tenantA.id, { name: "sales" });
    await setDestinationSecret(tenantA.id, destination.id, "webhook_signing_key", "tenant-a-secret");

    await expect(resolveDestinationSecretPlaintext(tenantB.id, destination.id, "webhook_signing_key")).rejects.toBeInstanceOf(
      DestinationSecretError,
    );
  });

  it("setting a secret with the same name again replaces it — the old plaintext is not retrievable, only the new one", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "old-value");
    await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "new-value");

    const plaintext = await resolveDestinationSecretPlaintext(tenant.id, destination.id, "webhook_signing_key");
    expect(plaintext).toBe("new-value");

    const rows = await prisma.destinationSecret.findMany({ where: { destinationId: destination.id, name: "webhook_signing_key" } });
    expect(rows).toHaveLength(1); // replaced in place, not accumulated
  });

  it("listing metadata never includes encryptedValue", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await setDestinationSecret(tenant.id, destination.id, "a", "value-a");
    await setDestinationSecret(tenant.id, destination.id, "b", "value-b");

    const list = await listDestinationSecretMetadata(tenant.id, destination.id);
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(Object.keys(item)).not.toContain("encryptedValue");
    }
  });

  it("deleting a secret makes it unresolvable afterward", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await setDestinationSecret(tenant.id, destination.id, "webhook_signing_key", "will-be-deleted");

    await deleteDestinationSecret(tenant.id, destination.id, "webhook_signing_key");

    await expect(resolveDestinationSecretPlaintext(tenant.id, destination.id, "webhook_signing_key")).rejects.toBeInstanceOf(
      DestinationSecretError,
    );
  });
});
