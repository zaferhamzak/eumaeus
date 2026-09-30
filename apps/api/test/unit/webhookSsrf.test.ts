import { describe, expect, it } from "vitest";
import { assertSsrfSafeUrl, SsrfBlockedError } from "../../src/modules/destinations/executors/ssrf.js";

/**
 * No real DNS lookups happen in this suite — every test either uses a literal IP
 * (no DNS involved at all) or an injected fake resolver, so SSRF protection is
 * proven against actual resolved addresses, not string pattern-matching on
 * hostnames (this phase's explicit instruction).
 */
function fakeDns(addresses: Array<{ address: string; family: number }>) {
  return async () => addresses;
}

describe("assertSsrfSafeUrl — protocol/hostname checks", () => {
  it("rejects a non-http(s) protocol", async () => {
    await expect(assertSsrfSafeUrl("ftp://example.com/file")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSsrfSafeUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSsrfSafeUrl("gopher://example.com")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects a malformed URL", async () => {
    await expect(assertSsrfSafeUrl("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects hostname localhost outright", async () => {
    await expect(assertSsrfSafeUrl("http://localhost/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSsrfSafeUrl("http://LOCALHOST/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a valid public https URL (mocked DNS resolving to a public address)", async () => {
    const target = await assertSsrfSafeUrl("https://hooks.example.com/webhook", fakeDns([{ address: "93.184.216.34", family: 4 }]));
    expect(target.address).toBe("93.184.216.34");
    expect(target.protocol).toBe("https:");
    expect(target.port).toBe(443);
  });

  it("default port is derived correctly for http", async () => {
    const target = await assertSsrfSafeUrl("http://hooks.example.com/webhook", fakeDns([{ address: "93.184.216.34", family: 4 }]));
    expect(target.port).toBe(80);
  });
});

describe("assertSsrfSafeUrl — literal IP addresses (no DNS involved)", () => {
  const blockedLiterals = [
    ["loopback", "http://127.0.0.1/hook"],
    ["10.x private", "http://10.1.2.3/hook"],
    ["172.16.x private", "http://172.16.5.5/hook"],
    ["172.31.x private (top of the /12)", "http://172.31.255.254/hook"],
    ["192.168.x private", "http://192.168.1.1/hook"],
    ["169.254.x link-local (covers the cloud metadata address's range)", "http://169.254.1.1/hook"],
    ["169.254.169.254 cloud metadata address exactly", "http://169.254.169.254/latest/meta-data/"],
    ["0.0.0.0", "http://0.0.0.0/hook"],
    ["multicast", "http://224.0.0.1/hook"],
    ["reserved (240.0.0.0/4)", "http://240.0.0.1/hook"],
    ["broadcast", "http://255.255.255.255/hook"],
  ] as const;

  for (const [label, url] of blockedLiterals) {
    it(`rejects ${label}`, async () => {
      await expect(assertSsrfSafeUrl(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  }

  it("allows a literal public IPv4 address", async () => {
    const target = await assertSsrfSafeUrl("http://93.184.216.34/hook");
    expect(target.address).toBe("93.184.216.34");
  });

  it("rejects classic string-filter-bypass IPv4 encodings — decimal, hex, octal, and shorthand all normalize to a real (blocked) address via the URL parser itself, not string matching", async () => {
    // new URL() (WHATWG) normalizes every one of these to "127.0.0.1" BEFORE
    // this module ever sees a hostname — verified directly against Node's own
    // URL parser, not assumed. isIP() + the blocklist then catch the real,
    // normalized address, exactly as they would for the plain dotted form.
    await expect(assertSsrfSafeUrl("http://2130706433/hook")).rejects.toBeInstanceOf(SsrfBlockedError); // decimal
    await expect(assertSsrfSafeUrl("http://0x7f000001/hook")).rejects.toBeInstanceOf(SsrfBlockedError); // hex
    await expect(assertSsrfSafeUrl("http://017700000001/hook")).rejects.toBeInstanceOf(SsrfBlockedError); // octal
    await expect(assertSsrfSafeUrl("http://0177.0.0.1/hook")).rejects.toBeInstanceOf(SsrfBlockedError); // octal first octet
    await expect(assertSsrfSafeUrl("http://127.1/hook")).rejects.toBeInstanceOf(SsrfBlockedError); // shorthand
  });

  it("rejects IPv6 loopback (::1)", async () => {
    await expect(assertSsrfSafeUrl("http://[::1]/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects IPv6 link-local (fe80::/10)", async () => {
    await expect(assertSsrfSafeUrl("http://[fe80::1]/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects IPv6 unique-local (fc00::/7)", async () => {
    await expect(assertSsrfSafeUrl("http://[fd00::1]/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects an IPv4-mapped IPv6 address pointing at a private range", async () => {
    await expect(assertSsrfSafeUrl("http://[::ffff:127.0.0.1]/hook")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a public IPv6 literal", async () => {
    const target = await assertSsrfSafeUrl("http://[2606:4700:4700::1111]/hook");
    expect(target.family).toBe(6);
  });
});

describe("assertSsrfSafeUrl — DNS resolution (public-looking hostname resolving to a private address)", () => {
  const cases: Array<[string, string, number]> = [
    ["10.x private", "10.0.0.5", 4],
    ["172.16.x private", "172.20.1.1", 4],
    ["192.168.x private", "192.168.0.1", 4],
    ["loopback", "127.0.0.1", 4],
    ["link-local / cloud metadata range", "169.254.169.254", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 link-local", "fe80::1", 6],
  ];

  for (const [label, address, family] of cases) {
    it(`rejects a hostname that resolves to a ${label} address (${address}) — proven via mocked DNS, not string matching`, async () => {
      await expect(
        assertSsrfSafeUrl("https://looks-public.example.com/hook", fakeDns([{ address, family }])),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  }

  it("rejects if ANY resolved address is private, even when another resolved address is public", async () => {
    await expect(
      assertSsrfSafeUrl(
        "https://multi-homed.example.com/hook",
        fakeDns([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects if DNS resolution returns no addresses at all", async () => {
    await expect(assertSsrfSafeUrl("https://no-records.example.com/hook", fakeDns([]))).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a hostname whose every resolved address is public", async () => {
    const target = await assertSsrfSafeUrl(
      "https://really-public.example.com/hook",
      fakeDns([{ address: "93.184.216.34", family: 4 }]),
    );
    expect(target.address).toBe("93.184.216.34");
    expect(target.hostname).toBe("really-public.example.com");
  });
});
