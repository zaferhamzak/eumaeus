import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

function samplePayload(overrides: Partial<{ name: string; rootNodeKey: string; nodes: unknown[] }> = {}) {
  return {
    name: "GitHub triage",
    rootNodeKey: "start",
    nodes: [
      {
        key: "start",
        conditions: { field: "sender.address", op: "contains", value: "github.com" },
        onTrue: { type: "node", nodeKey: "check-security" },
        onFalse: { type: "action", destinationRef: "archive" },
      },
      {
        key: "check-security",
        conditions: { field: "subject", op: "contains", value: "security" },
        onTrue: { type: "action", destinationRef: "security-webhook" },
        onFalse: { type: "action", destinationRef: "archive" },
      },
    ],
    ...overrides,
  };
}

describe("API — rule graphs", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates a valid graph", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "GitHub triage", enabled: true, version: 1, rootNodeKey: "start" });
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.map((n: { key: string }) => n.key).sort()).toEqual(["check-security", "start"]);
    await app.close();
  });

  it("retrieves a graph", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() });
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/api/v1/rule-graphs/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.json().nodes).toHaveLength(2);
    await app.close();
  });

  it("lists graphs", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() });

    const res = await app.inject({ method: "GET", url: "/api/v1/rule-graphs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    await app.close();
  });

  it("updating a graph version creates a NEW version — the old one is deactivated, never mutated in place", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() });
    const id = created.json().id as string;
    const firstVersionId = (await prisma.ruleGraphVersion.findFirstOrThrow({ where: { ruleGraphId: id } })).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/rule-graphs/${id}`,
      payload: samplePayload({ name: "GitHub triage v2" }),
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.id).toBe(id); // same graph identity
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("GitHub triage v2");

    const firstVersion = await prisma.ruleGraphVersion.findUniqueOrThrow({ where: { id: firstVersionId } });
    expect(firstVersion.deactivatedAt).not.toBeNull(); // old version deactivated, not deleted

    const allVersions = await prisma.ruleGraphVersion.findMany({ where: { ruleGraphId: id } });
    expect(allVersions).toHaveLength(2); // both versions still exist — history preserved
    await app.close();
  });

  it("rejects an invalid branch reference (points at a node key that doesn't exist)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const payload = samplePayload();
    (payload.nodes[0] as { onTrue: unknown }).onTrue = { type: "node", nodeKey: "does-not-exist" };

    const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects a malformed graph (duplicate node keys)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const payload = samplePayload();
    (payload.nodes as Array<{ key: string }>).push({ ...(payload.nodes[1] as { key: string }), key: "start" });

    const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a graph containing a cycle", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const payload = samplePayload();
    (payload.nodes[1] as { onFalse: unknown }).onFalse = { type: "node", nodeKey: "start" };

    const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("cycle detected");
    await app.close();
  });

  it("nothing is persisted when creation is rejected", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const payload = samplePayload();
    (payload.nodes[0] as { onTrue: unknown }).onTrue = { type: "node", nodeKey: "does-not-exist" };

    await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload });
    expect(await prisma.ruleGraph.count()).toBe(0);
    expect(await prisma.ruleNode.count()).toBe(0);
    await app.close();
  });

  describe("POST /rule-graphs/validate — structural validation without persisting", () => {
    it("reports a valid graph as valid, and writes nothing", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs/validate", payload: samplePayload() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: true, errors: [] });
      expect(await prisma.ruleGraph.count()).toBe(0);
      await app.close();
    });

    it("reports specific errors for an orphaned node", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const payload = samplePayload();
      (payload.nodes as Array<{ key: string; conditions: unknown; onTrue: unknown; onFalse: unknown }>).push({
        key: "orphan",
        conditions: { field: "has_attachment", op: "==", value: true },
        onTrue: { type: "action", destinationRef: "archive" },
        onFalse: { type: "action", destinationRef: "archive" },
      });

      const res = await app.inject({ method: "POST", url: "/api/v1/rule-graphs/validate", payload });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors.some((e: string) => e.includes("orphaned node"))).toBe(true);
      await app.close();
    });
  });

  it("a rule graph belonging to a different tenant cannot be edited by id", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB } = await createTestTenantAndMailbox();
    const appB = buildTestServer(tenantB.id);
    const created = await appB.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() });
    const id = created.json().id as string;

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "PATCH", url: `/api/v1/rule-graphs/${id}`, payload: samplePayload({ name: "hijacked" }) });
    expect(res.statusCode).toBe(404);

    const untouched = await prisma.ruleGraph.findUniqueOrThrow({ where: { id } });
    expect(untouched.name).toBe("GitHub triage");
    await appA.close();
    await appB.close();
  });

  describe("PUT /api/v1/rule-graphs/:id/enabled (Phase 12)", () => {
    it("disables and re-enables a graph without creating a new version, and audits both", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const created = (await app.inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() })).json();

      const off = await app.inject({ method: "PUT", url: `/api/v1/rule-graphs/${created.id}/enabled`, payload: { enabled: false } });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toMatchObject({ enabled: false, version: 1 });

      const on = await app.inject({ method: "PUT", url: `/api/v1/rule-graphs/${created.id}/enabled`, payload: { enabled: true } });
      expect(on.json()).toMatchObject({ enabled: true, version: 1 });

      const events = await prisma.auditEvent.findMany({ where: { tenantId: tenant.id, eventType: { in: ["rule_graph_enabled", "rule_graph_disabled"] } } });
      expect(events).toHaveLength(2);
    });

    it("404s a graph from another tenant", async () => {
      const { tenant: a } = await createTestTenantAndMailbox();
      const { tenant: b } = await createTestTenantAndMailbox();
      const graphB = (await buildTestServer(b.id).inject({ method: "POST", url: "/api/v1/rule-graphs", payload: samplePayload() })).json();
      const res = await buildTestServer(a.id).inject({ method: "PUT", url: `/api/v1/rule-graphs/${graphB.id}/enabled`, payload: { enabled: false } });
      expect(res.statusCode).toBe(404);
    });
  });
});

