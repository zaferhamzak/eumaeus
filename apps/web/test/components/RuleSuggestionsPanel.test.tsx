import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RuleSuggestionsPanel } from "@/components/senderLists/RuleSuggestionsPanel";
import type { RuleSuggestion } from "@/lib/api/senderLists";
import { renderWithQueryClient } from "../testUtils";

vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const suggestion: RuleSuggestion = {
  id: "rs1",
  kind: "rule",
  pattern: "shop.test|sale",
  status: "open",
  resolvedCount: 4,
  spamCount: 4,
  approvedCount: 0,
  createdAt: "2026-09-20T10:00:00Z",
  sender: "shop.test",
  word: "sale",
  decision: "spam",
  draft: {
    name: "shop.test: sale",
    priority: 50,
    conditions: { op: "AND", children: [{ field: "from.domain", op: "eq", value: "shop.test" }, { field: "subject", op: "contains", value: "sale" }] },
    destinationRef: null,
    affected: 7,
  },
} as RuleSuggestion;

function stubFetch() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/api/v1/destinations")) return json({ data: [{ id: "d1", name: "Junk", channels: [] }], pagination: { hasMore: false, nextCursor: null } });
      if (url.endsWith("/accept")) return json({ ...suggestion, status: "accepted", ruleId: "rule-9", impact: null });
      if (url.endsWith("/dismiss")) return json({ ...suggestion, status: "dismissed" });
      if (url.startsWith("/api/v1/rule-suggestions")) return json({ data: [suggestion] });
      return json({});
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("RuleSuggestionsPanel", () => {
  it("renders a suggestion with its sender, word, stats and reach", async () => {
    stubFetch();
    renderWithQueryClient(<RuleSuggestionsPanel />);
    expect(await screen.findByText("shop.test")).toBeInTheDocument();
    expect(screen.getByText(/subject contains “sale”/)).toBeInTheDocument();
    expect(screen.getByText("People marked them spam: 4 of 4")).toBeInTheDocument();
    expect(screen.getByText("Affects 7 emails in the last 30 days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create rule" })).toBeDisabled();
  });

  it("accepts with the chosen destination and links to the new rule", async () => {
    const calls = stubFetch();
    renderWithQueryClient(<RuleSuggestionsPanel />);
    await screen.findByText("shop.test");
    await screen.findByRole("option", { name: "Junk" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Junk" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/accept"))).toBe(true));
    const accept = calls.find((c) => c.url.endsWith("/accept"))!;
    expect(accept.url).toBe("/api/v1/rule-suggestions/rs1/accept");
    expect(accept.method).toBe("POST");
    expect(accept.body).toEqual({ destinationRef: "Junk" });
    const link = await screen.findByRole("link", { name: "shop.test: sale" });
    expect(link).toHaveAttribute("href", "/rules/rule-9");
  });

  it("shows the impact on a risky 409 and resends with confirmImpact", async () => {
    const calls = stubFetch();
    const base = vi.mocked(fetch).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/accept") && attempts++ === 0) {
        calls.push({ url: String(input), method: "POST", body: JSON.parse(String(init?.body)) });
        const impact = { days: 30, evaluated: 10, truncated: false, draftMatches: 3, currentMatches: 0, changed: 3, moves: [{ from: "human_review", to: "Junk", count: 3 }], shadowedBy: [], risky: { count: 0, samples: [] }, samples: [], divergence: 0, warnings: [] };
        return json({ error: { code: "CONFLICT", message: "Risky", details: { impact } } }, 409);
      }
      return base(input as string, init);
    });
    renderWithQueryClient(<RuleSuggestionsPanel />);
    await screen.findByRole("option", { name: "Junk" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Junk" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create anyway" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/accept"))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith("/accept"))[1]!.body).toEqual({ destinationRef: "Junk", confirmImpact: true });
  });

  it("dismiss calls the endpoint", async () => {
    const calls = stubFetch();
    renderWithQueryClient(<RuleSuggestionsPanel />);
    await screen.findByText("shop.test");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/rule-suggestions/rs1/dismiss" && c.method === "POST")).toBe(true));
  });

  it("explains the threshold when there is nothing to suggest", async () => {
    stubFetch();
    vi.mocked(fetch).mockImplementation(async () => json({ data: [] }));
    renderWithQueryClient(<RuleSuggestionsPanel />);
    expect(await screen.findByText(/at least 3 emails from one sender/)).toBeInTheDocument();
  });
});
