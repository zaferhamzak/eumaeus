import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";

describe("TRUST_PROXY", () => {
  const probe = async (trustProxy: boolean | number | string | undefined, remoteAddress: string) => {
    const app = buildServer({ logger: false, ...(trustProxy !== undefined ? { trustProxy } : {}) });
    app.get("/__ip", async (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: "GET", url: "/__ip", remoteAddress, headers: { "x-forwarded-for": "203.0.113.7, 172.18.0.5" } });
    return res.json().ip as string;
  };

  it("ignores X-Forwarded-For unless told to trust the proxy", async () => {
    expect(await probe(undefined, "172.18.0.4")).toBe("172.18.0.4");
  });

  it("trusting the private networks resolves Caddy → web → API to the real client", async () => {
    expect(await probe("127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16", "172.18.0.4")).toBe("203.0.113.7");
  });

  it("a request from outside the trusted networks can't spoof its address", async () => {
    expect(await probe("127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16", "198.51.100.9")).toBe("198.51.100.9");
  });
});
