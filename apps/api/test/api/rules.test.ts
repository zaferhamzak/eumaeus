import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

const sampleConditions = { field: "sender.domain", op: "==", value: "example.com" };

describe("API — rules", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates a rule", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { name: "r1", priority: 10, conditions: sampleConditions, destinationRef: "sales" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "r1", priority: 10, version: 1, enabled: true });
    await app.close();
  });

  it("rejects a rule referencing an unknown field", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      payload: { name: "bad", priority: 1, conditions: { field: "not.a.real.field", op: "==", value: "x" }, destinationRef: "sales" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lists rules, optionally filtered by enabled", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "r1", priority: 1, conditions: sampleConditions, destinationRef: "sales" } });

    const all = await app.inject({ method: "GET", url: "/api/v1/rules" });
    expect(all.json().data).toHaveLength(1);

    const disabled = await app.inject({ method: "GET", url: "/api/v1/rules?enabled=false" });
    expect(disabled.json().data).toHaveLength(0);
    await app.close();
  });

  it("gets rule detail", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "r1", priority: 1, conditions: sampleConditions, destinationRef: "sales" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/api/v1/rules/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    await app.close();
  });

  it("PATCH (edit) versions the rule — the old version is deactivated, never mutated in place, and a new row/version is created", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "r1", priority: 1, conditions: sampleConditions, destinationRef: "sales" } });
    const originalId = created.json().id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rules/${originalId}`,
      payload: { name: "r1-renamed", priority: 2, conditions: sampleConditions, destinationRef: "support" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.id).not.toBe(originalId); // a NEW row
    expect(updated.version).toBe(2);
    expect(updated.destinationRef).toBe("support");

    const original = await prisma.rule.findUniqueOrThrow({ where: { id: originalId } });
    expect(original.enabled).toBe(false);
    expect(original.destinationRef).toBe("sales"); // untouched — history preserved
    await app.close();
  });

  it("DELETE deactivates the rule (soft) rather than removing history", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "r1", priority: 1, conditions: sampleConditions, destinationRef: "sales" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "DELETE", url: `/api/v1/rules/${id}` });
    expect(res.statusCode).toBe(204);

    const row = await prisma.rule.findUniqueOrThrow({ where: { id } });
    expect(row.enabled).toBe(false);
    expect(row).toBeTruthy(); // still exists
    await app.close();
  });

  it("a rule belonging to a different tenant cannot be edited by id", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB } = await createTestTenantAndMailbox();
    const appB = buildTestServer(tenantB.id);
    const created = await appB.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "b-rule", priority: 1, conditions: sampleConditions, destinationRef: "sales" } });
    const id = created.json().id as string;

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({
      method: "PATCH",
      url: `/api/v1/rules/${id}`,
      payload: { name: "hijacked", priority: 99, conditions: sampleConditions, destinationRef: "hijacked" },
    });
    expect(res.statusCode).toBe(404);

    const untouched = await prisma.rule.findUniqueOrThrow({ where: { id } });
    expect(untouched.name).toBe("b-rule");
    await appA.close();
    await appB.close();
  });
});
