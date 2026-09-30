import { describe, expect, it } from "vitest";
import { parseAuthenticationResults, parseReceivedSpf, senderAuthFromHeaders, senderAuthFromRawSource } from "../../src/modules/ingestion/senderAuth.js";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import { evaluateCondition } from "../../src/modules/rules/conditions.js";
import { senderAuthFields } from "../../src/modules/rules/derivedFields.js";

const GMAIL =
  "mx.google.com;\r\n       dkim=pass header.i=@news.example.com header.s=s1 header.b=abc;\r\n       spf=pass (google.com: domain of bounce@mail.example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@mail.example.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com";

describe("parseAuthenticationResults (Phase 27)", () => {
  it("reads a Gmail verdict", () => {
    const r = parseAuthenticationResults(GMAIL.replace(/\r\n\s+/g, " "), "news@example.com")!;
    expect(r).toMatchObject({ source: "authentication-results", authservId: "mx.google.com", spf: "pass", dkim: "pass", dmarc: "pass", spfDomain: "mail.example.com", dkimDomains: ["news.example.com"], authenticated: true });
  });

  it("is authenticated by aligned SPF or DKIM even without DMARC", () => {
    expect(parseAuthenticationResults("mx.a.net; spf=pass smtp.mailfrom=x@sub.shop.com.tr", "info@shop.com.tr")?.authenticated).toBe(true);
    expect(parseAuthenticationResults("mx.a.net; dkim=pass header.d=shop.com.tr; spf=fail smtp.mailfrom=x@other.net", "info@shop.com.tr")?.authenticated).toBe(true);
  });

  it("is not authenticated when the passing domain belongs to someone else", () => {
    const r = parseAuthenticationResults("mx.a.net; spf=pass smtp.mailfrom=bulk@mailer.net; dkim=pass header.d=mailer.net; dmarc=fail header.from=bank.com", "security@bank.com")!;
    expect(r).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "fail", authenticated: false });
  });

  it("keeps the best of several DKIM signatures and marks unreported methods none", () => {
    const r = parseAuthenticationResults("mx.a.net; dkim=fail header.d=a.com; dkim=pass header.d=b.com", "x@b.com")!;
    expect(r).toMatchObject({ dkim: "pass", spf: "none", dmarc: "none", dkimDomains: ["b.com"], authenticated: true });
  });

  it("ignores semicolons inside comments and maps hardfail to fail", () => {
    const r = parseAuthenticationResults("mx.a.net; spf=hardfail (sender; not allowed) smtp.mailfrom=a@b.com", "a@b.com")!;
    expect(r.spf).toBe("fail");
  });

  it("reads a bare 'none' verdict", () => {
    expect(parseAuthenticationResults("mx.a.net; none", "a@b.com")).toMatchObject({ spf: "none", dkim: "none", dmarc: "none", authenticated: false });
  });
});

describe("Received-SPF fallback", () => {
  it("reads SPF only; DKIM/DMARC stay unknown", () => {
    const r = parseReceivedSpf("pass (mx: domain of a@b.com designates 1.2.3.4) client-ip=1.2.3.4; envelope-from=a@b.com;", "a@b.com")!;
    expect(r).toMatchObject({ source: "received-spf", spf: "pass", authenticated: true });
    expect(r.dkim).toBeUndefined();
    expect(parseReceivedSpf("softfail (…) envelope-from=a@b.com", "a@b.com")).toEqual({ source: "received-spf", spf: "softfail", spfDomain: "b.com" });
  });

  it("prefers Authentication-Results and only the topmost one", () => {
    const r = senderAuthFromHeaders(
      [
        { key: "authentication-results", value: "mx.provider.net; spf=fail smtp.mailfrom=a@bank.com; dmarc=fail header.from=bank.com" },
        { key: "received-spf", value: "pass envelope-from=a@bank.com" },
        { key: "authentication-results", value: "forged.example; spf=pass smtp.mailfrom=a@bank.com; dmarc=pass" },
      ],
      "a@bank.com",
    );
    expect(r).toMatchObject({ authservId: "mx.provider.net", spf: "fail", dmarc: "fail", authenticated: false });
  });
});

describe("ingestion + conditions", () => {
  it("parses the provider's header from a real message", async () => {
    const source = Buffer.from(
      [
        "Authentication-Results: mx.provider.net;",
        " spf=softfail smtp.mailfrom=promo@shop.example;",
        " dkim=none; dmarc=fail header.from=shop.example",
        "Authentication-Results: fake.example; dmarc=pass",
        "From: Shop <promo@shop.example>",
        "To: me@example.com",
        "Subject: Deal",
        "Date: Mon, 28 Sep 2026 10:00:00 +0000",
        "",
        "hi",
      ].join("\r\n"),
    );
    const normalized = await parseImapMessage({ uid: 1, uidValidity: 1, source });
    expect(normalized.senderAuth).toMatchObject({ spf: "softfail", dkim: "none", dmarc: "fail", authenticated: false });
    const none = await parseImapMessage({ uid: 2, uidValidity: 1, source: Buffer.from("From: a@b.com\r\nSubject: x\r\n\r\nhi") });
    expect(none.senderAuth).toBeNull();
  });

  it("sender.* conditions match the stored verdict and never match when unknown", () => {
    const derived = senderAuthFields({ source: "authentication-results", spf: "pass", dkim: "none", dmarc: "fail", authenticated: false });
    expect(senderAuthFields(null)).toEqual({});
    const ctx = { email: { fromAddress: "a@b.com", toAddresses: [], subject: "", hasAttachments: false, attachmentFilenames: [] }, answers: {}, derived };
    expect(evaluateCondition({ field: "sender.dmarc", op: "==", value: "fail" }, ctx).matched).toBe(true);
    expect(evaluateCondition({ field: "sender.authenticated", op: "==", value: false }, ctx).matched).toBe(true);
    const unknown = { ...ctx, derived: {} };
    expect(evaluateCondition({ field: "sender.authenticated", op: "==", value: false }, unknown).matched).toBe(false);
    expect(evaluateCondition({ field: "sender.spf", op: "!=", value: "pass" }, unknown).matched).toBe(false);
  });
});

describe("senderAuthFromRawSource", () => {
  it("reads the topmost verdict from the header block only", () => {
    const raw = Buffer.from(
      "Received: from x\r\nAuthentication-Results: mx.provider.net;\r\n spf=pass smtp.mailfrom=a@shop.com;\r\n dkim=pass header.d=shop.com; dmarc=pass header.from=shop.com\r\nAuthentication-Results: fake; dmarc=fail\r\nFrom: a@shop.com\r\n\r\nAuthentication-Results: in-body; spf=fail\r\n",
    );
    expect(senderAuthFromRawSource(raw, "a@shop.com")).toMatchObject({ authservId: "mx.provider.net", spf: "pass", dkim: "pass", dmarc: "pass", authenticated: true });
    expect(senderAuthFromRawSource(Buffer.from("From: a@b.com\r\n\r\nAuthentication-Results: x; spf=pass\r\n"), "a@b.com")).toBeNull();
  });
});
