import { beforeEach, describe, expect, it, vi } from "vitest";

let nextError: unknown = null;
const sentTo: string[] = [];

vi.mock("../../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/email/mailer.js")>()),
  sendTestEmail: async (to: string) => {
    if (nextError) throw nextError;
    sentTo.push(to);
  },
}));

const { buildServer } = await import("../../../src/api/server.js");
const { resetDatabase } = await import("../../helpers/db.js");

const ADMIN = { id: "admin", email: "admin@acme.test", isSuperAdmin: true };

function app() {
  return buildServer({ logger: false, authResolver: async () => ADMIN });
}

describe("0.13.1 — SMTP port/TLS validation and test email", () => {
  beforeEach(async () => {
    await resetDatabase();
    nextError = null;
    sentTo.length = 0;
  });

  it.each([
    [587, true, "Port 587"],
    [465, false, "Port 465"],
  ])("rejects port %i with implicit TLS %s", async (port, secure, message) => {
    const res = await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpHost: "smtp.acme.test", smtpPort: port, smtpSecure: secure } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain(message);
  });

  it("accepts the conventional combinations, and an unusual one when explicitly confirmed", async () => {
    expect((await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpHost: "smtp.acme.test", smtpPort: 587, smtpSecure: false } })).statusCode).toBe(200);
    expect((await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpPort: 465, smtpSecure: true } })).statusCode).toBe(200);
    expect((await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpPort: 587, smtpSecure: true, confirmUnusualTls: true } })).statusCode).toBe(200);
  });

  it("an unrelated save isn't blocked by an existing mismatched SMTP setup", async () => {
    await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpHost: "smtp.acme.test", smtpPort: 587, smtpSecure: true, confirmUnusualTls: true } });
    const res = await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { sessionTtlSeconds: 7200 } });
    expect(res.statusCode).toBe(200);
  });

  it("no host = nothing to check", async () => {
    const res = await app().inject({ method: "PATCH", url: "/api/v1/settings", payload: { smtpHost: null, smtpPort: 587, smtpSecure: true } });
    expect(res.statusCode).toBe(200);
  });

  it("sends the test email to the caller by default", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/settings/smtp-test", payload: {} });
    expect(res.json()).toEqual({ ok: true, to: "admin@acme.test" });
    expect(sentTo).toEqual(["admin@acme.test"]);
  });

  it("explains a TLS mismatch failure", async () => {
    nextError = Object.assign(new Error("C07E:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number"), { code: "ESOCKET", command: "CONN" });
    const res = await app().inject({ method: "POST", url: "/api/v1/settings/smtp-test", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, errorClass: "connection" });
    expect(res.json().hint).toContain("port 587");
  });

  it("explains an authentication failure", async () => {
    nextError = Object.assign(new Error("Invalid login"), { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 });
    const res = await app().inject({ method: "POST", url: "/api/v1/settings/smtp-test", payload: {} });
    expect(res.json()).toMatchObject({ ok: false, errorClass: "smtp_auth" });
    expect(res.json().hint).toContain("app password");
  });

  it("is super-admin only", async () => {
    const res = await buildServer({ logger: false, authResolver: async () => ({ ...ADMIN, isSuperAdmin: false }) }).inject({ method: "POST", url: "/api/v1/settings/smtp-test", payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
