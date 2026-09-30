import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { ImapMessageSource } from "./client.js";
import type { NormalizedAttachment, NormalizedEmail } from "../../../types/normalized-email.js";
import { FORWARDED_HEADER, LEGACY_FORWARDED_HEADER } from "../../email/forwardHeaders.js";
import { senderAuthFromHeaders } from "../../ingestion/senderAuth.js";

/**
 * The only place raw IMAP/MIME structure is understood. Converts one fetched
 * message into the provider-independent NormalizedEmail — everything after this
 * function runs never sees IMAP- or MIME-specific shapes again.
 *
 * SECURITY (architecture-review.md §3): this function extracts text — it never
 * evaluates, renders, or executes anything from the message. `htmlBody` is passed
 * through as an opaque string; it is application data, not markup this process (or
 * any future one) is permitted to trust. Attachment CONTENT is never read — only
 * filename/content-type/size metadata, via mailparser's own parsed attachment list
 * (mailparser does not execute attachment content either; it just reports what MIME
 * declared).
 */
export async function parseImapMessage(message: ImapMessageSource): Promise<NormalizedEmail> {
  const parsed = await simpleParser(message.source, {
    // Keep attachment metadata but avoid mailparser doing anything beyond parsing
    // MIME structure — it never interprets HTML/script content either way.
    skipHtmlToText: true,
  });

  const to = flattenAddresses(parsed.to);
  const cc = flattenAddresses(parsed.cc);
  const bcc = flattenAddresses(parsed.bcc);
  const from = flattenAddresses(parsed.from)[0] ?? "unknown@unknown";
  // Read from the raw header lines: mailparser restructures some headers
  // (List-* ends up under a "list" object, not "list-id"), and the checks
  // that depend on these must never silently see "absent".
  const headerText = (name: string): string | undefined => {
    const line = parsed.headerLines.find((h) => h.key === name)?.line;
    if (!line) return undefined;
    const value = line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
    return value.slice(0, 500) || undefined;
  };

  const attachments: NormalizedAttachment[] = parsed.attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  }));

  return {
    provider: "imap",
    externalId: String(message.uid),
    uidValidity: message.uidValidity,
    // RFC Message-ID, if present. Never used as identity — see NormalizedEmail's
    // doc comment and the "Missing Message-ID" test for why.
    messageId: normalizeMessageId(parsed.messageId),
    from,
    to,
    cc,
    bcc,
    subject: parsed.subject,
    // Fall back to "now" if the message genuinely has no Date header — an email
    // must always have a receivedAt for state-machine/audit ordering purposes, and
    // a missing/malformed Date header is attacker-controlled input, not something
    // to trust blindly either.
    receivedAt: parsed.date ?? new Date(),
    textBody: parsed.text,
    htmlBody: typeof parsed.html === "string" ? parsed.html : undefined,
    hasAttachments: attachments.length > 0,
    attachments,
    rawSource: message.source,
    // mailparser lowercases header names in its headers Map.
    forwardedByEumaeus: parsed.headers.has(FORWARDED_HEADER.toLowerCase()) || parsed.headers.has(LEGACY_FORWARDED_HEADER.toLowerCase()),
    replyHeaders: {
      autoSubmitted: headerText("auto-submitted"),
      precedence: headerText("precedence"),
      listId: headerText("list-id"),
      replyTo: flattenAddresses(parsed.replyTo)[0],
      senderName: parsed.from?.value[0]?.name?.trim().slice(0, 200) || undefined,
      inReplyTo: headerText("in-reply-to")?.slice(0, 1000),
      references: headerText("references")?.slice(0, 4000),
    },
    // Phase 27: the provider's SPF/DKIM/DMARC verdict (topmost header only — see senderAuth.ts).
    senderAuth: senderAuthFromHeaders(
      parsed.headerLines
        .filter((h) => h.key === "authentication-results" || h.key === "received-spf")
        .map((h) => ({ key: h.key, value: h.line.slice(h.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim().slice(0, 4000) })),
      from,
    ),
  };
}

function normalizeMessageId(messageId: ParsedMail["messageId"]): string | undefined {
  if (!messageId) return undefined;
  return messageId;
}

function flattenAddresses(input: AddressObject | AddressObject[] | undefined): string[] {
  if (!input) return [];
  const objects = Array.isArray(input) ? input : [input];
  const addresses: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value) {
      if (entry.address) addresses.push(entry.address);
    }
  }
  return addresses;
}
