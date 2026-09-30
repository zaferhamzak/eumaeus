import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RuleForm } from "@/components/rules/RuleForm";
import RulesPage from "@/app/rules/page";
import type { RuleImpact } from "@/lib/api/rules";
import { renderWithQueryClient } from "../testUtils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const emptyPage = { data: [], pagination: { hasMore: false, nextCursor: null } };

function impact(overrides: Partial<RuleImpact> = {}): RuleImpact {
  return {
    days: 30,
    evaluated: 12,
    truncated: false,
    draftMatches: 0,
    currentMatches: 0,
    changed: 0,
    moves: [],
    shadowedBy: [],
    risky: { count: 0, samples: [] },
    samples: [],
    divergence: 0,
    warnings: [],
    ...overrides,
  };
}

const riskySample = { emailId: "e1", subject: "Invoice 42", fromAddress: "billing@acme.test", receivedAt: "2026-09-20T10:00:00Z", from: "human_review", to: "junk", reason: "category invoice" };
const riskyImpact = impact({ draftMatches: 3, changed: 3, moves: [{ from: "human_review", to: "junk", count: 3 }], risky: { count: 1, samples: [riskySample] }, samples: [riskySample] });

const initial = { name: "Junk it", priority: 5, destinationRef: "junk", conditions: { field: "answers.is_spam", op: ">=", value: 0.8 } } as const;

function stubFetch(impactBody: RuleImpact) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/v1/rules/impact") return json(impactBody);
      return json(emptyPage);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("RuleForm — impact preview", () => {
  it("checks the impact, then saves directly when nothing changes", async () => {
    const calls = stubFetch(impact());
    const onSubmit = vi.fn();
    renderWithQueryClient(<RuleForm initial={{ ...initial }} submitLabel="Create rule" isSubmitting={false} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![1]).toEqual({});
    const preview = calls.find((c) => c.url === "/api/v1/rules/impact");
    expect(preview?.body).toMatchObject({ change: { type: "create", rule: { name: "Junk it", destinationRef: "junk" } } });
    expect(screen.queryByText("Impact of this change")).not.toBeInTheDocument();
  });

  it("previews an edit as an update of the replaced rule", async () => {
    const calls = stubFetch(impact());
    const onSubmit = vi.fn();
    renderWithQueryClient(<RuleForm initial={{ ...initial }} submitLabel="Save as new version" replaceRuleId="r1" isSubmitting={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(calls.find((c) => c.url === "/api/v1/rules/impact")?.body).toMatchObject({ change: { type: "update", ruleId: "r1" } });
  });

  it("a risky preview requires the checkbox and then saves with confirmImpact", async () => {
    stubFetch(riskyImpact);
    const onSubmit = vi.fn();
    renderWithQueryClient(<RuleForm initial={{ ...initial }} submitLabel="Create rule" isSubmitting={false} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    expect(await screen.findByText("Impact of this change")).toBeInTheDocument();
    expect(screen.getByText("1 business email would move to junk")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invoice 42" })).toHaveAttribute("href", "/emails/e1");
    expect(onSubmit).not.toHaveBeenCalled();

    const save = screen.getByRole("button", { name: "Save with this impact" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand business mail will move to junk." }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![1]).toEqual({ confirmImpact: true });
  });

  it("editing the form discards the preview", async () => {
    stubFetch(riskyImpact);
    renderWithQueryClient(<RuleForm initial={{ ...initial }} submitLabel="Create rule" isSubmitting={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    expect(await screen.findByText("Impact of this change")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Junk it"), { target: { value: "Junk it 2" } });
    expect(screen.queryByText("Impact of this change")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create rule" })).toBeEnabled();
  });
});

describe("Rules page — delete refused with impact", () => {
  it("shows the impact and retries with confirmImpact on Delete anyway", async () => {
    const rule = { id: "r1", tenantId: "t", name: "Keep invoices", priority: 1, enabled: true, version: 1, conditions: { field: "answers.is_spam", op: ">=", value: 0.8 }, destinationRef: "finance", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deactivatedAt: null };
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        // The rules page also lists destinations (for the "Notifies" badge).
        if (url.startsWith("/api/v1/destinations")) return json({ data: [], pagination: { hasMore: false, nextCursor: null } });
        calls.push({ url, method });
        if (method === "DELETE") {
          if (url.includes("confirmImpact=true")) return new Response(null, { status: 204 });
          return json({ error: { code: "CONFLICT", message: "This would move business mail.", requestId: "req", details: { impact: riskyImpact } } }, 409);
        }
        return json({ data: [rule], pagination: { hasMore: false, nextCursor: null } });
      }),
    );
    renderWithQueryClient(<RulesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete rule Keep invoices" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const anyway = await screen.findByRole("button", { name: "Delete anyway" });
    expect(screen.getByText("Deleting this rule moves business mail")).toBeInTheDocument();
    expect(screen.queryByText("This would move business mail.")).not.toBeInTheDocument();
    expect(anyway).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand business mail will move to junk." }));
    fireEvent.click(anyway);

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/rules/r1?confirmImpact=true")).toBe(true));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });
});
