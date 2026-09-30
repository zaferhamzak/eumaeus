import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { composeForward, describeAnalysis, ForwardSourceUnavailableError, renderSubject, type ForwardComposeInput } from "../../src/modules/destinations/executors/forwardMessage.js";
import { WITH_ATTACHMENT } from "../fixtures/rawMessages.js";

function input(overrides: Partial<ForwardComposeInput> = {}): ForwardComposeInput {
  return {
    config: { mode: "attachment", to: ["team@acme.test"] },
    sender: { address: "notify@acme.test", name: "Eumaeus" },
    recipients: { to: ["team@acme.test"], cc: [], bcc: [] },
    email: {
      id: "email-1",
      fromAddress: "promo@brand.test",
      toAddresses: ["inbox@acme.test"],
      ccAddresses: [],
      subject: "September sale",
      receivedAt: new Date("2026-09-25T12:00:00Z"),
      textBody: "Big discounts",
      htmlBody: "<p>Big discounts</p>",
      hasAttachments: true,
    },
    source: WITH_ATTACHMENT,
    destinationName: "Marketing",
    analysis: { is_spam: { noul: 0.12 }, category: { choice: "marketing" }, urgency: { score: 0, legend: { "0": "low" } } },
    messageId: "<fwd-abc@eumaeus>",
    ...overrides,
  };
}

describe("composeForward", () => {
  it("attachment mode: cover note + original as message/rfc822, loop marker, reply-to original sender", async () => {
    const { message, usedOriginalSource } = await composeForward(input());
    expect(usedOriginalSource).toBe(true);
    expect(message.subject).toBe("Fwd: September sale");
    expect(message.replyTo).toBe("promo@brand.test");
    expect(message.headers).toMatchObject({ "X-Eumaeus-Forwarded": "email-1", "Auto-Submitted": "auto-forwarded" });
    expect(message.attachments).toEqual([{ filename: "original-message.eml", content: WITH_ATTACHMENT, contentType: "message/rfc822" }]);
    expect(message.text).toContain("Jev analysis: spam score 0.12, category marketing, urgency low");
    expect(message.from).toEqual({ name: "Eumaeus", address: "notify@acme.test" });
  });

  it("attachment mode without a stored source falls back to the stored text and says so", async () => {
    const { message, usedOriginalSource } = await composeForward(input({ source: null }));
    expect(usedOriginalSource).toBe(false);
    expect(message.attachments).toBeUndefined();
    expect(message.text).toContain("no longer stored");
    expect(message.text).toContain("Big discounts");
  });

  it("inline mode re-attaches the original's attachments unless disabled", async () => {
    const withAttachments = await composeForward(input({ config: { mode: "inline", to: ["team@acme.test"] } }));
    expect(withAttachments.message.text).toContain("---------- Forwarded message ----------");
    expect((withAttachments.message.attachments ?? []).length).toBeGreaterThan(0);

    const without = await composeForward(input({ config: { mode: "inline", to: ["team@acme.test"], includeAttachments: false } }));
    expect(without.message.attachments).toBeUndefined();
  });

  it("escapes the original's header values in the cover HTML", async () => {
    const { message } = await composeForward(input({ config: { mode: "inline", to: ["t@acme.test"] }, source: null, email: { ...input().email, subject: "<script>x</script>" } }));
    expect(String(message.html)).not.toContain("<script>x</script>");
    expect(String(message.html)).toContain("&lt;script&gt;");
  });

  it("honours replyTo none, fromName, and a subject template", async () => {
    const { message } = await composeForward(
      input({ config: { mode: "attachment", to: ["t@acme.test"], replyTo: "none", fromName: "Marketing bot", subjectTemplate: "[{category}] {subject} from {sender}" } }),
    );
    expect(message.replyTo).toBeUndefined();
    expect(message.from).toEqual({ name: "Marketing bot", address: "notify@acme.test" });
    expect(message.subject).toBe("[marketing] September sale from promo@brand.test");
  });

  it("redirect mode prepends Resent-* headers to the untouched original and puts every recipient in the envelope", async () => {
    const { message } = await composeForward(input({ config: { mode: "redirect", to: ["a@acme.test"] }, recipients: { to: ["a@acme.test"], cc: [], bcc: ["hidden@acme.test"] } }));
    const raw = message.raw as Buffer;
    expect(raw.subarray(raw.length - WITH_ATTACHMENT.length).equals(WITH_ATTACHMENT)).toBe(true);
    const head = raw.subarray(0, raw.length - WITH_ATTACHMENT.length).toString();
    expect(head).toContain("Resent-To: a@acme.test");
    expect(head).toContain("X-Eumaeus-Forwarded: email-1");
    expect(head).not.toContain("hidden@acme.test");
    expect(message.envelope).toEqual({ from: "notify@acme.test", to: ["a@acme.test", "hidden@acme.test"] });
    const parsed = await simpleParser(raw);
    expect(parsed.headers.get("from")).toBeDefined();
  });

  it("redirect mode refuses when the original source is gone", async () => {
    await expect(composeForward(input({ config: { mode: "redirect", to: ["a@acme.test"] }, source: null }))).rejects.toBeInstanceOf(ForwardSourceUnavailableError);
  });
});

describe("renderSubject / describeAnalysis", () => {
  it("keeps a header on one line even if the original subject has line breaks", () => {
    const subject = renderSubject("Fwd: {subject}", { email: { ...input().email, subject: "a\r\nBcc: evil@x.test" }, destinationName: "d" });
    expect(subject).toBe("Fwd: a Bcc: evil@x.test");
  });

  it("skips malformed answers instead of guessing", () => {
    expect(describeAnalysis({ is_spam: { noul: "high" }, category: {} })).toEqual([]);
  });
});
