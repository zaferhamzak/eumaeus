import { describe, expect, it } from "vitest";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import { BASIC_MESSAGE, NO_MESSAGE_ID, WITH_ATTACHMENT, HIDDEN_HTML_CONTENT } from "../fixtures/rawMessages.js";

describe("parseImapMessage — IMAP message -> NormalizedEmail", () => {
  it("extracts sender/recipients/subject/date/body from a well-formed message", async () => {
    const normalized = await parseImapMessage({ uid: 101, uidValidity: 555, source: BASIC_MESSAGE });

    expect(normalized.provider).toBe("imap");
    expect(normalized.externalId).toBe("101");
    expect(normalized.uidValidity).toBe(555);
    expect(normalized.messageId).toBe("<basic-1@example.com>");
    expect(normalized.from).toBe("alice@example.com");
    expect(normalized.to).toEqual(["bob@eumaeus.test"]);
    expect(normalized.cc).toEqual(["carol@eumaeus.test"]);
    expect(normalized.bcc).toEqual([]);
    expect(normalized.subject).toBe("Quarterly proposal");
    expect(normalized.receivedAt.toISOString()).toBe("2026-09-21T10:15:00.000Z");
    expect(normalized.textBody).toContain("please find our proposal");
    expect(normalized.htmlBody).toContain("<p>Hi Bob");
    expect(normalized.hasAttachments).toBe(false);
    expect(normalized.attachments).toEqual([]);
  });

  it("detects attachments by metadata only, without exposing attachment content", async () => {
    const normalized = await parseImapMessage({ uid: 102, uidValidity: 555, source: WITH_ATTACHMENT });

    expect(normalized.hasAttachments).toBe(true);
    expect(normalized.attachments).toHaveLength(1);
    expect(normalized.attachments[0]).toMatchObject({ filename: "invoice.pdf", contentType: "application/pdf" });
    // NormalizedAttachment has no content field at all — this assertion documents
    // that guarantee at the type level as well as the runtime shape.
    expect(Object.keys(normalized.attachments[0]!)).toEqual(["filename", "contentType", "size"]);
  });

  it("passes HTML through as opaque data, not interpreted content", async () => {
    const normalized = await parseImapMessage({ uid: 103, uidValidity: 555, source: HIDDEN_HTML_CONTENT });

    // The parser must extract the raw HTML string as-is (so it can be shown to a
    // human later, or fed to a classifier in a future phase) — but it must not
    // strip/execute/interpret it as instructions. This is a stand-in assertion for
    // the "email content -> AI signals -> deterministic policy -> action" invariant
    // architecture-review.md §3 describes: this function's job stops at extraction.
    expect(normalized.htmlBody).toContain("IGNORE PREVIOUS INSTRUCTIONS");
    expect(normalized.subject).toBe("Normal looking subject");
  });

  describe("message without an RFC Message-ID header", () => {
    it("still produces a NormalizedEmail with a stable identity based on the IMAP UID", async () => {
      const normalized = await parseImapMessage({ uid: 104, uidValidity: 555, source: NO_MESSAGE_ID });

      expect(normalized.messageId).toBeUndefined();
      // Identity comes from the UID/UIDVALIDITY pair regardless of Message-ID —
      // this is the "deterministic/idempotent identity strategy" requirement.
      expect(normalized.externalId).toBe("104");
      expect(normalized.uidValidity).toBe(555);
      expect(normalized.from).toBe("noid@example.com");
      expect(normalized.subject).toBe("No Message-ID here");
    });
  });
});
