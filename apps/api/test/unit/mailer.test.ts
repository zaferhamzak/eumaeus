import { beforeEach, describe, expect, it } from "vitest";
import { isMailerConfigured, sendEmail, MailerNotConfiguredError } from "../../src/modules/email/mailer.js";
import { resetDatabase } from "../helpers/db.js";

describe("mailer — optional, best-effort outbound SMTP", () => {
  beforeEach(async () => {
    await resetDatabase(); // also clears modules/settings/systemSettings.ts's in-process cache — see that file's own comment
  });

  it("isMailerConfigured() is false when SMTP isn't configured yet (SystemSettings seeded fresh, SMTP_HOST unset in test env — see test/setup.ts)", async () => {
    await expect(isMailerConfigured()).resolves.toBe(false);
  });

  it("sendEmail() throws MailerNotConfiguredError rather than attempting a real connection when unconfigured", async () => {
    await expect(sendEmail({ to: "a@example.com", subject: "x", html: "x", text: "x", meta: { kind: "other" } })).rejects.toBeInstanceOf(MailerNotConfiguredError);
  });
});
