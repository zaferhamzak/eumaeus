import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import RulesPage from "@/app/rules/page";
import { renderWithQueryClient } from "../testUtils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

const rule = {
  id: "r1",
  tenantId: "t",
  name: "Spam",
  priority: 1,
  enabled: true,
  version: 1,
  conditions: { field: "answers.is_spam", op: ">=", value: 0.8 },
  destinationRef: "junk",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  deactivatedAt: null,
};

afterEach(() => vi.unstubAllGlobals());

/** Rules can be deleted from the list; the list shows active rules by default, so a deleted one disappears. */
describe("Rules page — delete", () => {
  it("lists only active rules by default and deletes one after confirmation", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        // The rules page also lists destinations (for the "Notifies" badge).
        if (url.startsWith("/api/v1/destinations")) return new Response(JSON.stringify({ data: [{ id: "d1", name: "junk", channels: [{ id: "c1", type: "email_notify", enabled: true, deactivatedAt: null }] }], pagination: { hasMore: false, nextCursor: null } }), { status: 200, headers: { "content-type": "application/json" } });
        calls.push({ url, method: init?.method ?? "GET" });
        if (init?.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        const data = deleted ? [] : [rule];
        return new Response(JSON.stringify({ data, pagination: { hasMore: false, nextCursor: null } }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    renderWithQueryClient(<RulesPage />);
    expect(await screen.findByText("Spam")).toBeInTheDocument();
    // 1.2: its destination also emails people.
    expect(await screen.findByText("Notifies")).toBeInTheDocument();
    expect(calls[0]!.url).toContain("enabled=true");

    fireEvent.click(screen.getByRole("button", { name: "Delete rule Spam" }));
    expect(screen.getByText("Delete this rule?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/rules/r1")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Spam")).not.toBeInTheDocument());
  });
});
