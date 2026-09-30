import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RuleHistory } from "@/components/rules/RuleHistory";
import { renderWithQueryClient } from "../testUtils";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

const cond = (op: string) => ({ op, children: [{ field: "subject", op: "contains", value: "fatura" }] });
const v = (version: number, active: boolean, destinationRef = "Finans") => ({ id: `r${version}`, version, name: "Fatura", priority: 10, destinationRef, conditions: cond(version === 1 ? "OR" : "AND"), createdAt: "2026-09-01T00:00:00Z", deactivatedAt: active ? null : "2026-09-02T00:00:00Z", active, matches: version * 3 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const impact = { days: 30, evaluated: 5, truncated: false, draftMatches: 2, currentMatches: 2, changed: 2, moves: [{ from: "Finans", to: "Junk", count: 2 }], shadowedBy: [], risky: { count: 2, samples: [{ emailId: "e1", subject: "Fatura", fromAddress: "a@b.test", receivedAt: "2026-09-01T00:00:00Z", from: "Finans", to: "Junk", reason: "goes to Finans today" }] }, samples: [], divergence: 0, warnings: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("RuleHistory (Phase 25)", () => {
  it("lists versions newest first with the current badge, and going back posts the version", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json({ rule: { id: "r3" }, restored: false, impact });
      }
      return json({ data: [v(1, false), v(2, true)] });
    }));
    renderWithQueryClient(<RuleHistory ruleId="r2" />);
    expect(await screen.findByText("current")).toBeInTheDocument();
    expect(screen.getByText(/Differs from the current version in: conditions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Go back to this version" }).at(-1)!);
    await waitFor(() => expect(posts).toEqual([{ version: 1 }]));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/rules/r3"));
  });

  it("a risky revert shows the impact and retries with confirmImpact after acknowledgement", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return body.confirmImpact ? json({ rule: { id: "r3" }, restored: false, impact }) : json({ error: { code: "CONFLICT", message: "risky", details: { impact } } }, 409);
      }
      return json({ data: [v(1, false, "Junk"), v(2, true)] });
    }));
    renderWithQueryClient(<RuleHistory ruleId="r2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Go back to this version" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Go back to this version" }).at(-1)!);
    const anyway = await screen.findByRole("button", { name: "Go back anyway" });
    expect(anyway).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(anyway);
    await waitFor(() => expect(posts.at(-1)).toEqual({ version: 1, confirmImpact: true }));
  });

  it("a taken priority asks for another and retries with it", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return body.priority ? json({ rule: { id: "r3" }, restored: true, impact }) : json({ error: { code: "CONFLICT", message: "Priority 10 is now used by rule X." } }, 409);
      }
      return json({ data: [v(1, false)] });
    }));
    renderWithQueryClient(<RuleHistory ruleId="r1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore with this version" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Restore with this version" }).at(-1)!);
    const input = await screen.findByLabelText("Priority");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ version: 1, priority: 12 }));
  });
});
