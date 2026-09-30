import { describe, expect, it } from "vitest";
import { emailText, reviewReason } from "../../src/modules/i18n/emailText.js";
import { buildInviteEmail } from "../../src/modules/email/inviteEmail.js";
import { buildReviewDigestEmail } from "../../src/modules/email/reviewDigestEmail.js";
import { buildForwardVerificationEmail } from "../../src/modules/email/forwardVerificationEmail.js";
import { buildAlertEmail } from "../../src/modules/email/alertEmail.js";
import { composeDigest } from "../../src/modules/destinations/executors/forwardDigestMessage.js";

/** Phase 21: system emails in the recipient's language. */
describe("email text", () => {
  it("fills placeholders and picks plural forms", () => {
    expect(emailText("en", "digestSubject", { count: 1, org: "Acme" })).toBe("1 new email awaiting review in Acme");
    expect(emailText("en", "digestSubject", { count: 3, org: "Acme" })).toBe("3 new emails awaiting review in Acme");
    expect(emailText("tr", "digestSubject", { count: 3, org: "Acme" })).toBe("Acme: 3 yeni mail kontrol bekliyor");
    expect(reviewReason("tr", "unmatched")).toBe("hiçbir kural eşleşmedi");
    expect(reviewReason("tr", "something_new")).toBe("something new");
  });

  it("builds Turkish system emails and still escapes untrusted text", () => {
    const invite = buildInviteEmail("<b>Acme</b>", "https://x/accept?token=t", "tr");
    expect(invite.subject).toBe("Eumaeus'ta <b>Acme</b> organizasyonuna davet edildiniz");
    expect(invite.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(invite.html).toContain("Daveti kabul et");

    const digest = buildReviewDigestEmail("Acme", 2, 5, [{ subject: null, fromAddress: "a@b.test", reason: "ambiguous" }], "https://x/review", "tr");
    expect(digest.text).toContain("(konu yok) — a@b.test (Jev bir insanın bakmasını önerdi)");
    expect(digest.text).toContain("…ve 1 tane daha");

    expect(buildForwardVerificationEmail("Acme", "https://x/v", 7, "tr").text).toContain("7 gün sonra dolar");
    expect(buildAlertEmail({ organizationName: "Acme", title: "Box down", detail: "d", resolved: true, link: "https://x/", locale: "tr" }).subject).toBe("Çözüldü: Box down (Acme, Eumaeus)");

    const d = composeDigest({
      config: { mode: "inline", delivery: "digest", to: ["x@y.test"] } as never,
      sender: { address: "jev@x.test", name: "Eumaeus" },
      recipients: { to: ["x@y.test"], cc: [], bcc: [] },
      destinationName: "Pazarlama",
      emails: [{ id: "e1", fromAddress: "a@b.test", subject: "Kampanya", receivedAt: new Date("2026-09-01T10:00:00Z"), textBody: "Merhaba", source: null }],
      batchId: "b1",
      locale: "tr",
    });
    expect(d.message.subject).toBe("Pazarlama hedefinden 1 mail (Eumaeus özeti)");
    expect(String(d.message.text)).toContain("Kimden: a@b.test");
  });

  it("defaults to English (unchanged output for existing callers)", () => {
    expect(buildInviteEmail("Acme", "https://x").subject).toBe("You've been invited to Acme on Eumaeus");
  });
});
