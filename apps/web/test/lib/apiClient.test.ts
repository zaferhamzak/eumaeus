import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiRequestError } from "@/lib/api/client";

function jsonResponse(body: unknown, init: ResponseInit & { requestId?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.requestId) headers.set("x-request-id", init.requestId);
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe("apiRequest — error parsing (§24/§37)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a successful response and returns the JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    const result = await apiRequest<{ ok: boolean }>("/api/v1/whatever");
    expect(result).toEqual({ ok: true });
  });

  it("parses the backend's consistent error shape into a typed ApiRequestError with a human message and request id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "RESOURCE_NOT_FOUND", message: "Email abc not found", requestId: "req-123" } },
          { status: 404, requestId: "req-123" },
        ),
      ),
    );
    await expect(apiRequest("/api/v1/emails/abc")).rejects.toMatchObject({
      message: "Email abc not found",
      code: "RESOURCE_NOT_FOUND",
      status: 404,
      requestId: "req-123",
    });
  });

  it("never surfaces a raw stack trace or SQL fragment — only the backend's own safe message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred", requestId: "req-1" } }, { status: 500 })),
    );
    try {
      await apiRequest("/api/v1/whatever");
      expect.fail("expected apiRequest to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      const message = (error as ApiRequestError).message;
      expect(message).not.toMatch(/at .*\.(ts|js):\d+/); // no stack frame text
      expect(message.toLowerCase()).not.toContain("select ");
    }
  });

  it("classifies a network failure (fetch itself throwing) distinctly, without pretending it's a backend error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(apiRequest("/api/v1/whatever")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("handles a 204 No Content response without attempting to parse a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const result = await apiRequest("/api/v1/destinations/x");
    expect(result).toBeUndefined();
  });

  it("builds relative URLs with query params, never an absolute/external origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest("/api/v1/emails", { query: { state: "failed", limit: 10, cursor: undefined } });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("/api/v1/emails?state=failed&limit=10");
    expect(calledUrl.startsWith("/")).toBe(true);
  });
});
