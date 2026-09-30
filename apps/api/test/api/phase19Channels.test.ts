import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

async function create(channel: object) {
  const { tenant } = await createTestTenantAndMailbox();
  return buildTestServer(tenant.id).inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "X", channels: [channel] } });
}

describe("Phase 19 channel validation", () => {
  beforeEach(resetDatabase);

  it("accepts each new type and never returns chat URLs in full", async () => {
    const slack = await create({ type: "slack", config: { url: "https://hooks.slack.test/services/T/B/SECRET" } });
    expect(slack.statusCode).toBe(201);
    expect(JSON.stringify(slack.json())).not.toContain("SECRET");
    await resetDatabase();
    expect((await create({ type: "auto_reply", config: { body: "Thanks!", cooldownDays: 3 } })).json().channels[0].config).toMatchObject({ body: "Thanks!", cooldownDays: 3, maxSpamScore: 0.5 });
    await resetDatabase();
    expect((await create({ type: "jira", config: { baseUrl: "https://acme.atlassian.test/", projectKey: "SUP", accountEmail: "Bot@Acme.test", secretName: "jira" } })).json().channels[0].config).toMatchObject({ baseUrl: "https://acme.atlassian.test", issueType: "Task", accountEmail: "bot@acme.test" });
    await resetDatabase();
    expect((await create({ type: "zendesk", config: { subdomain: "Acme", accountEmail: "bot@acme.test", secretName: "zd", priority: "urgent" } })).statusCode).toBe(201);
  });

  it.each([
    [{ type: "auto_reply", config: {} }, "body"],
    [{ type: "auto_reply", config: { body: "x", cooldownDays: 0 } }, "cooldownDays"],
    [{ type: "slack", config: { url: "http://hooks.slack.test/x" } }, "https"],
    [{ type: "jira", config: { baseUrl: "https://a.test", projectKey: "support", accountEmail: "b@a.test", secretName: "s" } }, "projectKey"],
    [{ type: "jira", config: { baseUrl: "https://a.test", projectKey: "SUP", accountEmail: "b@a.test" } }, "secretName"],
    [{ type: "zendesk", config: { subdomain: "acme.zendesk.com", accountEmail: "b@a.test", secretName: "s" } }, "subdomain"],
    [{ type: "zendesk", config: { subdomain: "acme", accountEmail: "b@a.test", secretName: "s", priority: "asap" } }, "priority"],
  ])("rejects %j", async (channel, message) => {
    const res = await create(channel);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(message);
  });
});
