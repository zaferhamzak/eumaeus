import type { SenderAuth } from "../modules/ingestion/senderAuth.js";
/**
 * The provider-independent internal representation of an email.
 *
 * This is the boundary described in the Phase 1 brief:
 *
 *   provider-specific representation (IMAP today, Gmail later)
 *           v
 *   NormalizedEmail  <-- everything below this line only ever touches this type
 *           v
 *   rest of Eumaeus
 *
 * A future Gmail connector produces the same shape from a completely different raw
 * format; nothing downstream of `persistNormalizedEmail` needs to know or care which
 * provider produced it.
 */
export interface NormalizedAttachment {
  filename: string | undefined;
  contentType: string;
  size: number;
}

export interface NormalizedEmail {
  provider: "imap";

  /**
   * Provider-specific identity. For IMAP this is the UID, scoped to the mailbox
   * connection and the UIDVALIDITY epoch it was observed under (see uidValidity
   * below) — this pair is what the database's uniqueness constraint is built on.
   *
   * Deliberately NOT the RFC Message-ID: Message-ID is attacker-controlled,
   * frequently missing, and occasionally duplicated across distinct messages in the
   * wild, so it cannot be a safe identity key. It is preserved separately as
   * `messageId` for metadata/display purposes only.
   */
  externalId: string;
  uidValidity: number;

  /** RFC Message-ID header, if present. Metadata only — never used for identity. */
  messageId?: string;

  from: string;
  to: string[];
  cc: string[];
  bcc: string[];

  subject?: string;
  receivedAt: Date;

  /**
   * Extracted body content. Treated as opaque, untrusted data everywhere downstream:
   * htmlBody in particular is never rendered as trusted application HTML and never
   * interpreted as instructions (see architecture-review.md §3).
   */
  textBody?: string;
  htmlBody?: string;

  hasAttachments: boolean;
  /** Attachment metadata only — content is never extracted or stored in Phase 1. */
  attachments: NormalizedAttachment[];

  /**
   * Phase 13: the original MIME bytes, persisted for a bounded time as an
   * EmailSource row so the forward executor can send the real message
   * (attachments included) without reading it back from the provider.
   * Optional: a provider or test that doesn't supply it simply gets no
   * EmailSource row.
   */
  rawSource?: Buffer;
  /** Phase 13: the message carries Eumaeus's own forwarded-marker header (modules/email/forwardHeaders.ts). */
  forwardedByEumaeus?: boolean;
  /** Phase 19: headers the auto-reply channel must respect (RFC 3834), when the provider supplied them. */
  replyHeaders?: {
    autoSubmitted?: string;
    precedence?: string;
    listId?: string;
    replyTo?: string;
    senderName?: string;
    /** Phase 22: threading headers (raw Message-ID lists), for the email.is_reply condition. */
    inReplyTo?: string;
    references?: string;
  };
  /**
   * Phase 27: the receiving provider's SPF/DKIM/DMARC verdict; null = it left
   * none; undefined = not read (sources other than the IMAP parser).
   */
  senderAuth?: SenderAuth | null;
}
