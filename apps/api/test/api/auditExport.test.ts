import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { csvCell } from "../../src/modules/audit/exportCsv.js";

describe("audit CSV export", () => {
  beforeEach(resetDatabase);

  it("quotes cells and defuses spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe("");
  });

  it("streams the range oldest first, only this organization, across batches", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const other = await createTestTenantAndMailbox();
    const base = new Date("2026-09-01T00:00:00Z").getTime();
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 1205 }, (_, i) => ({ tenantId: tenant.id, eventType: i === 3 ? "special" : "e", actor: "system", payload: { i, subject: i === 0 ? "=cmd()" : "x" }, createdAt: new Date(base + i * 1000) })),
    });
    await prisma.auditEvent.create({ data: { tenantId: other.tenant.id, eventType: "e", actor: "system", createdAt: new Date(base) } });
    await prisma.auditEvent.create({ data: { tenantId: tenant.id, eventType: "e", actor: "system", createdAt: new Date("2026-10-05T00:00:00Z") } });

    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/audit/export.csv?from=2026-09-01&to=2026-09-02" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("eumaeus-audit-2026-09-01-2026-09-02.csv");
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("created_at,event_type,actor,email_id,payload");
    expect(lines).toHaveLength(1206);
    expect(lines[1]).toContain("2026-09-01T00:00:00.000Z");
    expect(lines[1]).toContain('"{""i"":0,""subject"":""=cmd()""}"'); // inside JSON the cell starts with "{" — harmless
    expect(lines[1205]).toContain('""i"":1204');

    const one = await app.inject({ method: "GET", url: "/api/v1/audit/export.csv?from=2026-09-01&to=2026-09-02&eventType=special" });
    expect(one.body.trim().split("\r\n")).toHaveLength(2);

    expect((await app.inject({ method: "GET", url: "/api/v1/audit/export.csv?from=2026-10-01&to=2026-09-01" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/audit/export.csv?from=2024-01-01&to=2026-01-01" })).statusCode).toBe(400);
  });

  it("needs audit:read", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["emails:read"]);
    const app = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    const res = await app.inject({ method: "GET", url: "/api/v1/audit/export.csv?from=2026-09-01&to=2026-09-02", headers: { "x-organization-id": tenant.id } });
    expect(res.statusCode).toBe(403);
  });
});
