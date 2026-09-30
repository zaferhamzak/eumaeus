import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { MAX_EMAIL_BODY_CHARS } from "../../src/api/serializers/emailSerializer.js";

describe("API — email body response size limit (§15)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("a body within the limit is returned in full, with truncated: false", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { textBody: "short body" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}?includeBody=true` });
    const body = res.json().body;
    expect(body.text).toBe("short body");
    expect(body.truncated).toBe(false);
    await app.close();
  });

  it("a body larger than the cap is truncated, with truncated: true — never silently", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const huge = "a".repeat(MAX_EMAIL_BODY_CHARS + 5000);
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { textBody: huge });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}?includeBody=true` });
    const body = res.json().body;
    expect(body.text.length).toBe(MAX_EMAIL_BODY_CHARS);
    expect(body.truncated).toBe(true);
    await app.close();
  });

  it("truncation never alters the stored content — a later fetch (or a non-truncated re-check) still reflects the full original", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const huge = "b".repeat(MAX_EMAIL_BODY_CHARS + 5000);
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { textBody: huge });
    const app = buildTestServer(tenant.id);

    await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}?includeBody=true` });

    const { prisma } = await import("../../src/db/client.js");
    const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(stored.textBody?.length).toBe(huge.length); // unchanged in the database
    await app.close();
  });
});
