/**
 * Phase 27: what the receiving mail provider concluded about the sender —
 * SPF, DKIM and DMARC — read from the Authentication-Results header (RFC 8601)
 * it stamped on the message, or from Received-SPF when there is none.
 *
 * Eumaeus never re-checks DNS itself: the provider saw the SMTP session, we
 * only see the stored message. Which header is trusted:
 *
 *   - only the TOPMOST Authentication-Results. Headers are prepended on the
 *     way in, so the topmost one is the last hop's — the mailbox provider's.
 *     A sender can put any Authentication-Results it likes into the message,
 *     but those sit below the provider's and are never read.
 *   - Received-SPF only when there is no Authentication-Results at all (SPF
 *     only; DKIM and DMARC then stay unknown).
 *
 * Limitation: a provider that stamps neither header leaves a sender-supplied
 * one on top. Every mainstream provider (Gmail, Microsoft 365, Yandex,
 * cPanel/Exim, …) stamps one.
 *
 * `authenticated` is true when DMARC passed, or SPF or DKIM passed for a
 * domain aligned with the From domain (relaxed: equal, or one a subdomain of
 * the other). It is false when the provider's verdict shows neither, and
 * unknown (absent) when only Received-SPF was available and SPF didn't prove
 * it — DKIM might have.
 */
export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";

export interface SenderAuth {
  source: "authentication-results" | "received-spf";
  /** The provider that checked it (authserv-id), e.g. "mx.google.com". */
  authservId?: string;
  spf?: AuthVerdict;
  dkim?: AuthVerdict;
  dmarc?: AuthVerdict;
  spfDomain?: string;
  /** Domains whose DKIM signature passed. */
  dkimDomains?: string[];
  authenticated?: boolean;
}

const VERDICTS = new Set<AuthVerdict>(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"]);
// "hardfail" is an older spelling some SPF implementations still write.
const normalizeVerdict = (raw: string): AuthVerdict | undefined => {
  const v = raw.toLowerCase();
  if (v === "hardfail") return "fail";
  return VERDICTS.has(v as AuthVerdict) ? (v as AuthVerdict) : undefined;
};

// Better verdicts win when a method appears more than once (several DKIM signatures).
const RANK: Record<AuthVerdict, number> = { pass: 7, policy: 6, neutral: 5, none: 4, softfail: 3, temperror: 2, permerror: 1, fail: 0 };

function stripComments(value: string): string {
  let out = value;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\([^()]*\)/g, " ");
  } while (out !== previous);
  return out;
}

function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
  const d = (v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v).toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(d) ? d : undefined;
}

export function isAligned(a: string | undefined, fromDomain: string | undefined): boolean {
  if (!a || !fromDomain) return false;
  return a === fromDomain || a.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${a}`);
}

export function parseAuthenticationResults(header: string, fromAddress: string): SenderAuth | null {
  const parts = stripComments(header).split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const authservId = parts[0]!.split(/\s+/)[0]?.toLowerCase();
  const result: SenderAuth = { source: "authentication-results", ...(authservId && !authservId.includes("=") ? { authservId } : {}) };
  const dkimDomains: string[] = [];
  let sawMethod = false;

  for (const part of parts) {
    const m = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)\b(.*)$/is.exec(part);
    if (!m) continue;
    sawMethod = true;
    const method = m[1]!.toLowerCase() as "spf" | "dkim" | "dmarc";
    const verdict = normalizeVerdict(m[2]!);
    if (!verdict) continue;
    const props = Object.fromEntries([...m[3]!.matchAll(/([a-z]+\.[a-z-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)].map((p) => [p[1]!.toLowerCase(), p[2]!]));
    if (method === "dkim" && verdict === "pass") {
      const d = domainOf(props["header.d"] ?? props["header.i"]);
      if (d && !dkimDomains.includes(d)) dkimDomains.push(d);
    }
    if (method === "spf") {
      const d = domainOf(props["smtp.mailfrom"] ?? props["smtp.helo"]);
      if (d && (result.spf === undefined || RANK[verdict] > RANK[result.spf])) result.spfDomain = d;
    }
    if (result[method] === undefined || RANK[verdict] > RANK[result[method]!]) result[method] = verdict;
  }
  if (!sawMethod) {
    // "mx.example.com; none" — the provider checked and found nothing to check.
    if (parts.slice(1).some((p) => /^none$/i.test(p)) || (parts.length === 1 && /\bnone$/i.test(parts[0]!))) {
      return { ...result, spf: "none", dkim: "none", dmarc: "none", authenticated: false };
    }
    return null;
  }
  // A method the provider didn't report was not checked, which for mail it received means "none".
  result.spf ??= "none";
  result.dkim ??= "none";
  result.dmarc ??= "none";
  if (dkimDomains.length > 0) result.dkimDomains = dkimDomains;
  const from = domainOf(fromAddress);
  result.authenticated =
    result.dmarc === "pass" || (result.spf === "pass" && isAligned(result.spfDomain, from)) || (result.dkim === "pass" && dkimDomains.some((d) => isAligned(d, from)));
  return result;
}

export function parseReceivedSpf(header: string, fromAddress: string): SenderAuth | null {
  const m = /^\s*([a-z]+)\b/i.exec(header);
  const verdict = m ? normalizeVerdict(m[1]!) : undefined;
  if (!verdict) return null;
  const mailfrom = /envelope-from=("[^"]*"|[^\s;]+)/i.exec(header)?.[1] ?? /smtp\.mailfrom=("[^"]*"|[^\s;]+)/i.exec(header)?.[1];
  const spfDomain = domainOf(mailfrom);
  const aligned = verdict === "pass" && isAligned(spfDomain, domainOf(fromAddress));
  return { source: "received-spf", spf: verdict, ...(spfDomain ? { spfDomain } : {}), ...(aligned ? { authenticated: true } : {}) };
}

/**
 * The sender verdict from a message's header lines, in their order in the
 * message (topmost first). Null = the provider left no verdict (unknown).
 */
export function senderAuthFromHeaders(headerLines: Array<{ key: string; value: string }>, fromAddress: string): SenderAuth | null {
  const ar = headerLines.find((h) => h.key === "authentication-results");
  if (ar) return parseAuthenticationResults(ar.value, fromAddress);
  const spf = headerLines.find((h) => h.key === "received-spf");
  return spf ? parseReceivedSpf(spf.value, fromAddress) : null;
}

/** Reads a stored senderAuth JSON value defensively (it is ingestion output, but still JSON). */
export function readSenderAuth(value: unknown): SenderAuth | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<SenderAuth>;
  if (v.source !== "authentication-results" && v.source !== "received-spf") return null;
  return v as SenderAuth;
}

/**
 * The same verdict read straight from a stored raw message (only its header
 * block — the body is never parsed). Used to fill in mail ingested before
 * the verdict was captured.
 */
export function senderAuthFromRawSource(source: Buffer | Uint8Array, fromAddress: string): SenderAuth | null {
  const raw = Buffer.from(source).toString("latin1");
  const end = raw.search(/\r?\n\r?\n/);
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const lines = block
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim().slice(0, 4000) } : null;
    })
    .filter((h): h is { key: string; value: string } => h !== null && (h.key === "authentication-results" || h.key === "received-spf"));
  return senderAuthFromHeaders(lines, fromAddress);
}
