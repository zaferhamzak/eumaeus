import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEmailsList } from "@/hooks/useEmails";
import { makeEmail } from "../fixtures";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** §5/§29/§45 item #6 ("pagination bugs") — proves the cursor is actually threaded through to the SECOND request, and that requesting the next page appends rather than replaces the first page's rows. */
describe("useEmailsList — cursor pagination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the first page with no cursor, then the next page using the cursor the backend returned", async () => {
    const page1 = { data: [makeEmail({ id: "email-1" })], pagination: { nextCursor: "cursor-abc", hasMore: true } };
    const page2 = { data: [makeEmail({ id: "email-2" })], pagination: { nextCursor: null, hasMore: false } };

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useEmailsList({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.pages).toHaveLength(1);
    expect(result.current.data?.pages[0]?.data.map((e) => e.id)).toEqual(["email-1"]);

    const firstCallUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstCallUrl).not.toContain("cursor="); // no cursor on the first page

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    const secondCallUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain("cursor=cursor-abc");

    // Both pages' rows are available (appended, not replaced) — a real list UI flattens these.
    const allIds = result.current.data?.pages.flatMap((p) => p.data.map((e) => e.id));
    expect(allIds).toEqual(["email-1", "email-2"]);
    expect(result.current.hasNextPage).toBe(false); // page 2 said hasMore: false
  });

  it("passes filter values through as query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { nextCursor: null, hasMore: false } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useEmailsList({ state: "failed", sender: "alice@example.com" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("state=failed");
    expect(calledUrl).toContain("sender=alice%40example.com");
  });
});
