import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import { createReviewActionToken, verifyReviewActionToken, ReviewActionError } from "../../src/modules/review/reviewActionTokens.js";
import { loadEnv } from "../../src/config/env.js";

/** Things made under the product's former name (Jev Mail) must keep working after the rename to Eumaeus. */
describe("rename compatibility", () => {
  it("a copy forwarded before the rename (X-JevMail-Forwarded) is still recognised as our own", async () => {
    const legacy = Buffer.from("From: a@x.test\r\nTo: b@x.test\r\nSubject: Fwd\r\nX-JevMail-Forwarded: old\r\n\r\nhi");
    const current = Buffer.from("From: a@x.test\r\nTo: b@x.test\r\nSubject: Fwd\r\nX-Eumaeus-Forwarded: new\r\n\r\nhi");
    const plain = Buffer.from("From: a@x.test\r\nTo: b@x.test\r\nSubject: Hi\r\n\r\nhi");
    expect((await parseImapMessage({ uid: 1, uidValidity: 1, source: legacy })).forwardedByEumaeus).toBe(true);
    expect((await parseImapMessage({ uid: 2, uidValidity: 1, source: current })).forwardedByEumaeus).toBe(true);
    expect((await parseImapMessage({ uid: 3, uidValidity: 1, source: plain })).forwardedByEumaeus).toBe(false);
  });

  it("digest links signed before the rename still verify; others don't", () => {
    const token = createReviewActionToken({ tenantId: "t", itemId: "i", resolution: "spam", userId: "u" });
    const [body] = token.split(".");
    const legacyKey = createHmac("sha256", Buffer.from(loadEnv().SECRET_ENCRYPTION_KEY, "base64")).update("jevmail:review-action:v1").digest();
    const legacyMac = createHmac("sha256", legacyKey).update(body!).digest("base64url");
    expect(verifyReviewActionToken(`${body}.${legacyMac}`)).toMatchObject({ t: "t", i: "i" });
    expect(verifyReviewActionToken(token)).toMatchObject({ t: "t", i: "i" });
    const otherKey = createHmac("sha256", Buffer.from(loadEnv().SECRET_ENCRYPTION_KEY, "base64")).update("something-else").digest();
    expect(() => verifyReviewActionToken(`${body}.${createHmac("sha256", otherKey).update(body!).digest("base64url")}`)).toThrow(ReviewActionError);
  });
});
