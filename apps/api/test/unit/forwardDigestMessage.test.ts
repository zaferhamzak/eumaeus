import { describe, expect, it } from "vitest";
import { composeDigest, MAX_DIGEST_ATTACHMENT_BYTES, type DigestEmail } from "../../src/modules/destinations/executors/forwardDigestMessage.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";

function email(n: number, overrides: Partial<DigestEmail> = {}): DigestEmail {
  return {
    id: `e${n}`,
    fromAddress: `sender${n}@brand.test`,
    subject: `Offer ${n}`,
    receivedAt: new Date("2026-09-25T12:00:00Z"),
    textBody: `Body ${n}`,
    source: BASIC_MESSAGE,
    analysis: { category: { choice: "marketing" } },
    ...overrides,
  };
}

const base = {
  sender: { address: "notify@acme.test", name: "Eumaeus" },
  recipients: { to: ["team@acme.test"], cc: [], bcc: [] },
  destinationName: "Marketing",
  batchId: "batch-1",
};

describe("composeDigest", () => {
  it("attachment mode: one message listing every email, each original attached", () => {
    const { message, attached, notAttached } = composeDigest({ ...base, config: { mode: "attachment", delivery: "digest", to: ["team@acme.test"] }, emails: [email(1), email(2)] });
    expect(message.subject).toBe("2 emails from Marketing (Eumaeus digest)");
    expect(attached).toBe(2);
    expect(notAttached).toBe(0);
    expect(message.attachments?.map((a) => a.contentType)).toEqual(["message/rfc822", "message/rfc822"]);
    expect(message.text).toContain("1. Offer 1");
    expect(message.text).toContain("Jev analysis: category marketing");
    expect(message.headers).toMatchObject({ "X-Eumaeus-Forwarded": "digest:batch-1" });
    expect(message.replyTo).toBeUndefined();
  });

  it("stops attaching at the size limit and notes the rest", () => {
    const big = Buffer.alloc(MAX_DIGEST_ATTACHMENT_BYTES - 10);
    const { attached, notAttached, message } = composeDigest({ ...base, config: { mode: "attachment", to: ["t@acme.test"] }, emails: [email(1, { source: big }), email(2), email(3, { source: null })] });
    expect(attached).toBe(1);
    expect(notAttached).toBe(2);
    expect(message.text).toContain("size limit");
    expect(message.text).toContain("no longer stored");
  });

  it("inline mode: excerpts, no attachments, escaped HTML", () => {
    const { message } = composeDigest({ ...base, config: { mode: "inline", to: ["t@acme.test"], includeAnalysis: false }, emails: [email(1, { subject: "<b>x</b>", textBody: "a".repeat(800) })] });
    expect(message.attachments).toBeUndefined();
    expect(String(message.html)).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(message.text).toContain("…");
    expect(message.text).not.toContain("Jev analysis");
    expect(message.subject).toBe("1 email from Marketing (Eumaeus digest)");
  });
});
