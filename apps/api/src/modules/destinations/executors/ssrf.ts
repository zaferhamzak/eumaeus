import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF policy for the webhook executor (Phase 5B §6). A DestinationChannel's
 * webhook `url` is TENANT-SUPPLIED CONFIGURATION DATA, not a trusted internal
 * value — a malicious or careless tenant could point it at internal
 * infrastructure (a cloud metadata endpoint, an internal admin panel, another
 * service on the private network) and use Eumaeus's own server as a proxy to
 * reach it. This module is the one place that decision is made, and it is made
 * BEFORE any TCP connection is attempted.
 *
 * Policy (documented here, exercised by test/integration/webhookSsrf.test.ts):
 *   - protocol MUST be http: or https: — nothing else (file:, gopher:, ftp:, ...)
 *   - hostname "localhost" is rejected outright, independent of DNS
 *   - every IP address the hostname resolves to (or the literal IP, if the URL
 *     already contains one) is checked against a blocklist of non-public ranges:
 *     loopback, private RFC1918, link-local (which covers the
 *     169.254.169.254 cloud-metadata address), multicast, and other IANA-reserved
 *     ranges, for both IPv4 and IPv6 (including IPv4-mapped IPv6 addresses,
 *     checked as their embedded IPv4 form).
 *   - if ANY resolved address is blocked, the whole request is rejected — a
 *     hostname that resolves to both a public and a private address is not
 *     "partially safe."
 *
 * DNS-rebinding mitigation: this function returns the SPECIFIC validated IP
 * address alongside the original hostname. The caller (webhookHttpClient.ts) MUST
 * connect to that exact address — never re-resolve the hostname at connect time —
 * so a DNS record that changes between this check and the actual request cannot
 * redirect the connection to a different (possibly private) address. This is the
 * best mitigation available at this architectural layer (a single-process HTTP
 * client with no external network proxy); it does not protect against a DNS
 * response that changes between two lookups within this same check (a lookup
 * returning multiple addresses is fully validated — every one, not just the
 * first).
 */

export class SsrfBlockedError extends Error {}

export interface SsrfValidatedTarget {
  hostname: string;
  port: number;
  protocol: "http:" | "https:";
  /** The specific IP address validated as safe — the caller must connect to exactly this address, not re-resolve the hostname. */
  address: string;
  family: 4 | 6;
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function assertSsrfSafeUrl(rawUrl: string, lookupFn: DnsLookupFn = defaultDnsLookup): Promise<SsrfValidatedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`malformed URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`unsupported protocol "${parsed.protocol}" — only http and https are allowed`);
  }

  const hostname = parsed.hostname;
  if (hostname.toLowerCase() === "localhost") {
    throw new SsrfBlockedError('hostname "localhost" is not allowed');
  }

  // URL.hostname keeps the [brackets] around a literal IPv6 address (per the
  // WHATWG URL spec) — net.isIP() does NOT accept them, so an unbracketed form
  // is required here or a bracketed IPv6 literal would be (incorrectly) treated
  // as a hostname needing DNS resolution instead of being recognized directly.
  const bareHostname = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  const literalFamily = isIP(bareHostname); // 0 = not a literal IP, 4 or 6 otherwise
  const candidates: Array<{ address: string; family: number }> =
    literalFamily !== 0 ? [{ address: bareHostname, family: literalFamily }] : await lookupFn(hostname);

  if (candidates.length === 0) {
    throw new SsrfBlockedError(`DNS resolution for "${hostname}" returned no addresses`);
  }

  for (const candidate of candidates) {
    if (isBlockedAddress(candidate.address, candidate.family)) {
      throw new SsrfBlockedError(`resolved address ${candidate.address} for "${hostname}" is in a blocked (non-public) range`);
    }
  }

  const chosen = candidates[0] as { address: string; family: number };
  return {
    hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
    protocol: parsed.protocol as "http:" | "https:",
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/** IPv4 blocklist: loopback, RFC1918 private ranges, link-local (covers the 169.254.169.254 cloud metadata address), unspecified, documentation/benchmarking ranges, multicast, and reserved space. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true; // malformed -> fail closed
  const [a, b, c] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10.0.0.0/8 — RFC1918 private
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, includes the 169.254.169.254 cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC1918 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 — TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 — TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 — TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** IPv6 blocklist: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7), multicast (ff00::/8), and IPv4-mapped addresses (::ffff:a.b.c.d), re-checked against the IPv4 blocklist using the embedded address. */
function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified

  // IPv4-mapped IPv6, dotted-quad form: ::ffff:127.0.0.1
  const v4MappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedDotted) return isBlockedIpv4(v4MappedDotted[1] as string);

  // IPv4-mapped IPv6, compressed-hex form: URL's own parser normalizes
  // "::ffff:127.0.0.1" to "::ffff:7f00:1" (each pair of IPv4 octets packed into
  // one hex hextet) — this is the form that actually reaches this function from
  // assertSsrfSafeUrl, not the dotted form above (kept for any caller that
  // passes an already-dotted address directly, e.g. a literal from dns.lookup).
  const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const high = parseInt(v4MappedHex[1] as string, 16);
    const low = parseInt(v4MappedHex[2] as string, 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  const firstHextet = parseInt(normalized.split(":")[0] || "0", 16);
  if (Number.isNaN(firstHextet)) return true; // malformed -> fail closed
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 unique-local
  if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true; // ff00::/8 multicast

  return false;
}
