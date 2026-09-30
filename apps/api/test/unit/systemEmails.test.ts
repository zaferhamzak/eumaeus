import { describe, expect, it } from "vitest";
import { buildInviteEmail } from "../../src/modules/email/inviteEmail.js";
import { buildForwardVerificationEmail } from "../../src/modules/email/forwardVerificationEmail.js";
import { buildReviewDigestEmail } from "../../src/modules/email/reviewDigestEmail.js";
import { buildAssignmentEmail } from "../../src/modules/review/assignmentNotify.js";
import { EMAIL_LOGO_CID } from "../../src/modules/email/emailLogo.js";

/** 1.0.2: every system email is drawn in the shared frame (emailLayout.ts). */
describe("system emails in the shared frame", () => {
  it("each one is a full HTML document with the inline logo, a badge and a button", () => {
    const messages = [
      buildInviteEmail("Acme", "https://app.test/accept-invite?token=t", "tr"),
      buildForwardVerificationEmail("Acme", "https://app.test/verify-forward?token=t", 7, "tr"),
      buildReviewDigestEmail("Acme", 1, 3, [{ subject: "Hi", fromAddress: "a@b.test", reason: "unmatched" }], "https://app.test/review", "tr"),
      buildAssignmentEmail("Acme", [{ id: "r1", subject: "Hi", fromAddress: "a@b.test", reason: "ambiguous" }], "https://app.test", "tr"),
    ];
    for (const m of messages) {
      expect(m.html.startsWith("<!doctype html>")).toBe(true);
      expect(m.html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
      expect(m.inlineImages[0]!.cid).toBe(EMAIL_LOGO_CID);
      expect(m.html).toContain("&rarr;</a>");
    }
    expect(messages[0]!.html).toContain("Davet");
    expect(messages[0]!.html).toContain('href="https://app.test/accept-invite?token=t"');
    expect(messages[1]!.html).toContain("Onay gerekiyor");
    expect(messages[3]!.html).toContain("Size atandı");
    expect(messages[3]!.html).toContain('href="https://app.test/review/r1"');
  });

  it("the review digest lists each email with its one-click decisions as buttons", () => {
    const m = buildReviewDigestEmail(
      "Acme",
      3,
      5,
      [{ subject: "Invoice", fromAddress: "billing@x.test", reason: "low_confidence", actions: { spamUrl: "https://app.test/review-action?d=spam", approveUrl: "https://app.test/review-action?d=ok" } }],
      "https://app.test/review",
      "en",
    );
    expect(m.html).toContain("Invoice");
    expect(m.html).toContain("billing@x.test · low confidence");
    expect(m.html).toContain('href="https://app.test/review-action?d=spam"');
    expect(m.html).toContain(">Looks fine</a>");
    expect(m.html).toContain("…and 2 more");
    expect(m.text).toContain("Spam: https://app.test/review-action?d=spam");
  });

  it("subjects and senders from inbound mail are escaped", () => {
    const digest = buildReviewDigestEmail("Acme", 1, 1, [{ subject: "<img src=x onerror=alert(1)>", fromAddress: '"><script>', reason: "unmatched" }], "https://app.test/review");
    const assigned = buildAssignmentEmail("Acme", [{ id: "r1", subject: "<b>x</b>", fromAddress: "a@b.test", reason: "unmatched" }], "https://app.test", "en");
    expect(digest.html).not.toContain("<img src=x");
    expect(digest.html).not.toContain("<script>");
    expect(assigned.html).not.toContain("<b>x</b>");
    expect(assigned.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
