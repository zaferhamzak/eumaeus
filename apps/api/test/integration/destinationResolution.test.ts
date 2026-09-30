import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resolveDestination } from "../../src/modules/destinations/resolveDestination.js";
import { createDestination, createDestinationChannel, updateDestinationChannel, DestinationValidationError } from "../../src/modules/destinations/manageDestinations.js";
import { resetDatabase } from "../helpers/db.js";

async function createTenant(name: string) {
  return prisma.tenant.create({ data: { name } });
}

describe("destination resolution", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("a tenant can resolve its own destination", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await createDestinationChannel(tenant.id, destination.id, { type: "archive", config: { folder: "Sales" } });

    const resolved = await resolveDestination(tenant.id, "sales");
    expect(resolved).not.toBeNull();
    expect(resolved?.destination.id).toBe(destination.id);
    expect(resolved?.channels).toHaveLength(1);
  });

  it("tenant A cannot resolve tenant B's destination, even with a colliding destinationRef string", async () => {
    const tenantA = await createTenant("Tenant A");
    const tenantB = await createTenant("Tenant B");

    const destinationB = await createDestination(tenantB.id, { name: "sales" });
    await createDestinationChannel(tenantB.id, destinationB.id, { type: "archive", config: { folder: "Sales" } });

    const resolvedByA = await resolveDestination(tenantA.id, "sales");
    expect(resolvedByA).toBeNull();
  });

  it("a disabled channel is excluded from resolution", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "archive", config: { folder: "Sales" } });
    await prisma.destinationChannel.update({ where: { id: channel.id }, data: { enabled: false } });

    const resolved = await resolveDestination(tenant.id, "sales");
    // Zero enabled channels -> treated as unresolved, same as the destination not existing at all.
    expect(resolved).toBeNull();
  });

  it("a deactivated (versioned-over) channel is excluded, but the current version resolves", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    const v1 = await createDestinationChannel(tenant.id, destination.id, { type: "archive", config: { folder: "Old" } });
    const v2 = await updateDestinationChannel(v1.id, { type: "archive", config: { folder: "New" } });

    const resolved = await resolveDestination(tenant.id, "sales");
    expect(resolved?.channels).toHaveLength(1);
    expect(resolved?.channels[0]?.id).toBe(v2.id);
    expect(resolved?.channels[0]?.version).toBe(2);
  });

  it("rejects a channel type that isn't supported (Phase 5A: archive, Phase 5B: + webhook)", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    await expect(
      createDestinationChannel(tenant.id, destination.id, { type: "slack", config: {} }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
  });

  it("Phase 5B: a webhook channel with a valid https url is accepted", async () => {
    const tenant = await createTenant("Tenant A");
    const destination = await createDestination(tenant.id, { name: "sales" });
    const channel = await createDestinationChannel(tenant.id, destination.id, {
      type: "webhook",
      config: { url: "https://example.com/hook" },
    });
    expect(channel.type).toBe("webhook");
  });

  it("rejects creating a destination named the reserved human_review value", async () => {
    const tenant = await createTenant("Tenant A");
    await expect(createDestination(tenant.id, { name: "human_review" })).rejects.toBeInstanceOf(DestinationValidationError);
  });
});
