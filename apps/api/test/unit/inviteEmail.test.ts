import { describe, expect, it } from "vitest";
import { buildInviteEmail } from "../../src/modules/email/inviteEmail.js";

describe("buildInviteEmail", () => {
  it("embeds the real organization name and accept URL in both text and html", () => {
    const email = buildInviteEmail("Acme Security", "https://app.example.com/accept-invite?token=abc123");
    expect(email.subject).toContain("Acme Security");
    expect(email.text).toContain("Acme Security");
    expect(email.text).toContain("https://app.example.com/accept-invite?token=abc123");
    expect(email.html).toContain("Acme Security");
    expect(email.html).toContain("https://app.example.com/accept-invite?token=abc123");
  });

  it("escapes HTML-significant characters in the organization name (never raw-interpolated into the html body)", () => {
    const email = buildInviteEmail('<script>alert("x")</script>', "https://app.example.com/accept-invite?token=abc");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
