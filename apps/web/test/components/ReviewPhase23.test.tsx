import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import ReviewPage from "@/app/review/page";
import ReviewActionPage from "@/app/review-action/page";
import { DecideSimilarCard } from "@/components/review/DecideSimilarCard";
import { renderWithQueryClient } from "../testUtils";

const push = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useSearchParams: () => searchParams }));
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

afterEach(() => {
  vi.unstubAllGlobals();
  searchParams = new URLSearchParams();
  push.mockReset();
});

type Call = { url: string; method: string; body: unknown };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Routes fetch by URL; records every call. */
function stubFetch(route: (url: string, method: string, body: unknown) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      return route(url, method, body) ?? json({ data: [], pagination: { hasMore: false, nextCursor: null } });
    }),
  );
  return calls;
}

function item(id: string, subject: string) {
  return {
    id,
    tenantId: "t",
    emailId: `e-${id}`,
    reason: "unmatched",
    status: "open",
    resolution: null,
    assignedTo: null,
    resolvedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    emailPreview: { subject, fromAddress: "a@acme.test" },
    signal: null,
  };
}

describe("Review action page (digest one-click link)", () => {
  const preview = { organizationName: "Acme", resolution: "spam", subject: "Win a prize", fromAddress: "x@spam.test", alreadyClosed: false, status: "open" };

  it("only previews on load and decides only after the Confirm click", async () => {
    searchParams = new URLSearchParams("token=tok-1234567890");
    const calls = stubFetch((url, method) => {
      if (url.startsWith("/api/v1/review-actions/preview")) return json(preview);
      if (url === "/api/v1/review-actions" && method === "POST") return json({ ...preview, alreadyClosed: false, status: "resolved", resolved: true });
      return undefined;
    });
    renderWithQueryClient(<ReviewActionPage />);

    expect(await screen.findByText("Win a prize")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls[0]!.url).toBe("/api/v1/review-actions/preview?token=tok-1234567890");

    fireEvent.click(screen.getByRole("button", { name: "Mark as spam" }));
    expect(await screen.findByText("Marked as spam.")).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ url: "/api/v1/review-actions", method: "POST", body: { token: "tok-1234567890" } }]);
  });

  it("shows the API's message for an invalid or expired link", async () => {
    searchParams = new URLSearchParams("token=tok-expired-000");
    stubFetch(() => json({ error: { code: "VALIDATION_ERROR", message: "This link has expired.", requestId: "r" } }, 400));
    renderWithQueryClient(<ReviewActionPage />);
    expect(await screen.findByText("This link has expired.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("Human Review list — keyboard shortcuts", () => {
  it("j moves the highlight and s marks the highlighted item as spam via the bulk endpoint", async () => {
    const calls = stubFetch((url, method) => {
      if (url.startsWith("/api/v1/reviews?")) return json({ data: [item("r1", "First"), item("r2", "Second")], pagination: { hasMore: false, nextCursor: null } });
      if (url === "/api/v1/reviews/resolve" && method === "POST") return json({ resolved: 1, skipped: 0, data: [] });
      return undefined;
    });
    renderWithQueryClient(<ReviewPage />);
    expect(await screen.findByText("First")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(screen.getByText("Second").closest("tr")).toHaveAttribute("aria-current", "true"));
    fireEvent.keyDown(window, { key: "s" });

    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/reviews/resolve")).toBe(true));
    const post = calls.find((c) => c.url === "/api/v1/reviews/resolve")!;
    expect(post.body).toEqual({ itemIds: ["r2"], resolution: "spam" });
    expect(calls.some((c) => /\/api\/v1\/reviews\/r\d\/resolve/.test(c.url))).toBe(false);
  });

  it("ignores shortcut keys typed into a form field", async () => {
    const calls = stubFetch((url) => (url.startsWith("/api/v1/reviews?") ? json({ data: [item("r1", "First")], pagination: { hasMore: false, nextCursor: null } }) : undefined));
    renderWithQueryClient(<ReviewPage />);
    expect(await screen.findByText("First")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Filter by reason"), { key: "s" });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Decide similar", () => {
  it("narrows by a word and marks all (plus the current item) as spam in one bulk request", async () => {
    const calls = stubFetch((url, method) => {
      if (url.startsWith("/api/v1/reviews/cur/similar")) {
        const narrowed = url.includes("word=invoice");
        return json({
          sender: "acme.test",
          words: ["invoice", "overdue"],
          word: narrowed ? "invoice" : null,
          items: narrowed
            ? [{ id: "s1", emailId: "e1", subject: "Invoice 1", fromAddress: "a@acme.test", createdAt: "2026-09-01T00:00:00Z" }]
            : [
                { id: "s1", emailId: "e1", subject: "Invoice 1", fromAddress: "a@acme.test", createdAt: "2026-09-01T00:00:00Z" },
                { id: "s2", emailId: "e2", subject: "Hello", fromAddress: "b@acme.test", createdAt: "2026-09-01T00:00:00Z" },
              ],
          truncated: false,
        });
      }
      if (url === "/api/v1/reviews/resolve" && method === "POST") return json({ resolved: 2, skipped: 0, data: [] });
      return undefined;
    });
    renderWithQueryClient(<DecideSimilarCard reviewId="cur" currentOpen canResolve />);

    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("acme.test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "invoice" }));
    await waitFor(() => expect(screen.queryByText("Hello")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "invoice" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Mark all as spam" }));
    expect(screen.getByText("Mark 2 emails as spam?")).toBeInTheDocument();
    const dialogButtons = screen.getAllByRole("button", { name: "Mark all as spam" });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);

    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/reviews/resolve")).toBe(true));
    expect(calls.find((c) => c.url === "/api/v1/reviews/resolve")!.body).toEqual({ itemIds: ["cur", "s1"], resolution: "spam" });
  });
});
