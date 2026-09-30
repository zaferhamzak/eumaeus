import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

const spam = { field: "answers.is_spam", op: ">=", value: 0.8 };
const offer = { field: "answers.category", op: "==", value: "job_offer" };

describe("rule import/export", () => {
  beforeEach(resetDatabase);

  it("exports active rules and imports them into another organization", async () => {
    const a = await createTestTenantAndMailbox();
    const b = await createTestTenantAndMailbox();
    await prisma.destination.create({ data: { tenantId: b.tenant.id, name: "junk" } });
    const appA = buildTestServer(a.tenant.id);
    await appA.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Spam", priority: 1, conditions: spam, destinationRef: "junk" } });
    const old = await appA.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Old", priority: 2, conditions: offer, destinationRef: "jobs" } });
    await appA.inject({ method: "DELETE", url: `/api/v1/rules/${old.json().id}` });
    await appA.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Jobs", priority: 5, conditions: offer, destinationRef: "jobs" } });

    const file = (await appA.inject({ method: "GET", url: "/api/v1/rules/export" })).json();
    expect(file).toMatchObject({ format: "eumaeus.rules", version: 1, destinations: ["jobs", "junk"] });
    expect(file.rules.map((r: { name: string }) => r.name)).toEqual(["Spam", "Jobs"]);
    expect(JSON.stringify(file)).not.toContain(a.tenant.id);

    const appB = buildTestServer(b.tenant.id);
    const preview = (await appB.inject({ method: "POST", url: "/api/v1/rules/import", payload: { rules: file, dryRun: true } })).json();
    expect(preview).toMatchObject({ dryRun: true, valid: true, created: 0, errors: [] });
    expect(preview.warnings).toEqual([expect.objectContaining({ name: "Jobs", message: expect.stringContaining('"jobs"') })]);
    expect(await prisma.rule.count({ where: { tenantId: b.tenant.id } })).toBe(0);

    const done = (await appB.inject({ method: "POST", url: "/api/v1/rules/import", payload: { rules: file } })).json();
    expect(done).toMatchObject({ valid: true, created: 2 });
    const rules = await prisma.rule.findMany({ where: { tenantId: b.tenant.id }, orderBy: { priority: "asc" } });
    expect(rules.map((r) => [r.name, r.priority, r.destinationRef])).toEqual([["Spam", 1, "junk"], ["Jobs", 5, "jobs"]]);
    expect(await prisma.auditEvent.count({ where: { tenantId: b.tenant.id, eventType: "rules_imported" } })).toBe(1);
  });

  it("is all-or-nothing, resolves priority clashes by appending, and replace deactivates the old set", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Existing", priority: 1, conditions: spam, destinationRef: "junk" } });

    const bad = (
      await app.inject({
        method: "POST",
        url: "/api/v1/rules/import",
        payload: { rules: [{ name: "Clash", priority: 1, conditions: offer, destinationRef: "x" }, { name: "Broken", priority: 2, conditions: { field: "nope", op: "==", value: 1 }, destinationRef: "x" }] },
      })
    ).json();
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e: { name: string }) => e.name)).toEqual(["Clash", "Broken"]);
    expect(await prisma.rule.count({ where: { tenantId: tenant.id } })).toBe(1);

    const appended = (
      await app.inject({
        method: "POST",
        url: "/api/v1/rules/import",
        payload: { priorities: "append", rules: [{ name: "B", priority: 7, conditions: offer, destinationRef: "human_review" }, { name: "A", priority: 1, conditions: spam, destinationRef: "human_review" }] },
      })
    ).json();
    expect(appended).toMatchObject({ valid: true, created: 2, warnings: [] });
    expect(appended.rules).toEqual([expect.objectContaining({ name: "B", priority: 20 }), expect.objectContaining({ name: "A", priority: 10 })]);

    const replaced = (await app.inject({ method: "POST", url: "/api/v1/rules/import", payload: { mode: "replace", rules: [{ name: "Only", priority: 1, conditions: spam, destinationRef: "junk" }] } })).json();
    expect(replaced).toMatchObject({ created: 1, deactivated: 3 });
    expect((await prisma.rule.findMany({ where: { tenantId: tenant.id, deactivatedAt: null } })).map((r) => r.name)).toEqual(["Only"]);

    expect((await app.inject({ method: "POST", url: "/api/v1/rules/import", payload: { rules: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/rules/import", payload: { rules: { format: "other", version: 1, rules: [] } } })).statusCode).toBe(400);
    // Files exported before the rename (format "jevmail.rules") still import.
    const legacyFile = { format: "jevmail.rules", version: 1, rules: [{ name: "Legacy", priority: 50, conditions: spam, destinationRef: "junk" }] };
    expect((await app.inject({ method: "POST", url: "/api/v1/rules/import", payload: { rules: legacyFile, dryRun: true } })).json()).toMatchObject({ valid: true, errors: [] });
  });

  it("replace needs rules:delete as well as rules:write", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["rules:read", "rules:write"]);
    const app = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    const headers = { "x-organization-id": tenant.id };
    const rules = [{ name: "R", priority: 1, conditions: spam, destinationRef: "junk" }];
    expect((await app.inject({ method: "POST", url: "/api/v1/rules/import", headers, payload: { mode: "replace", rules } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/rules/import", headers, payload: { rules } })).statusCode).toBe(200);
  });
});
