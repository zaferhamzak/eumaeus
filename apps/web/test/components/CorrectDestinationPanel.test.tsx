import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CorrectDestinationPanel } from "@/components/email/CorrectDestinationPanel";
import type { RoutingDecisionResponse } from "@/types/api";
import { renderWithQueryClient } from "../testUtils";

const granted = new Set<string>();
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: (p: string) => granted.has(p) }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const decision = {
  id: "d1",
  tenantId: "t1",
  emailId: "e1",
  status: "matched",
  matchedRuleId: "r0",
  matchedRuleVersion: 1,
  destinationRef: "Spam",
  ruleGraphId: null,
  ruleGraphVersion: null,
  graphPath: null,
  senderListEntryId: null,
  senderListPattern: null,
  supersededAt: null,
} as unknown as RoutingDecisionResponse;

const impact = {
  days: 30,
  evaluated: 12,
  truncated: false,
  draftMatches: 3,
  currentMatches: 0,
  changed: 3,
  moves: [{ from: "Spam", to: "Sales", count: 3 }],
  shadowedBy: [],
  risky: { count: 0, samples: [] },
  samples: [],
  divergence: 0,
  warnings: [],
};

const draft = {
  rule: {
    name: "acme.com invoices → Sales",
    priority: 5,
    destinationRef: "Sales",
    conditions: { op: "AND", children: [{ field: "from", op: "equals", value: "bob@acme.com" }, { field: "subject", op: "contains", value: "invoice" }] },
  },
  alsoWrong: 2,
  word: "invoice",
  impact,
};

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

function stubApi(): FetchMock {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/v1/destinations")) {
      return jsonResponse({
        data: [
          { id: "dst1", name: "Sales", tenantId: "t1", description: null, channels: [], createdAt: "", updatedAt: "" },
          { id: "dst2", name: "Spam", tenantId: "t1", description: null, channels: [], createdAt: "", updatedAt: "" },
        ],
        pagination: { hasMore: false, nextCursor: null },
      });
    }
    if (url === "/api/v1/emails/e1/correct" && init?.method === "POST") {
      return jsonResponse({ previousDestination: "Spam", movedBack: true, decision: { ...decision, id: "d2", destinationRef: "Sales" } });
    }
    if (url.startsWith("/api/v1/emails/e1/correction-rule")) return jsonResponse(draft);
    if (url === "/api/v1/rules" && init?.method === "POST") return jsonResponse({ id: "rule-new", ...draft.rule, enabled: true, version: 1 }, 201);
    return jsonResponse({ error: { code: "NOT_FOUND", message: "not found", requestId: "r" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function correctTo(name: string) {
  const select = await screen.findByRole("combobox", { name: "Where this email belongs" });
  await screen.findByRole("option", { name });
  fireEvent.change(select, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Move it there" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Move it there" }));
}

beforeEach(() => {
  granted.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CorrectDestinationPanel", () => {
  it("is hidden without emails:reprocess", () => {
    stubApi();
    granted.add("rules:read");
    const { container } = renderWithQueryClient(<CorrectDestinationPanel emailId="e1" decision={decision} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Wrong place?")).not.toBeInTheDocument();
  });

  it("posts the chosen destination, then loads and shows the rule draft", async () => {
    const fetchMock = stubApi();
    ["emails:reprocess", "rules:read", "rules:write"].forEach((p) => granted.add(p));
    renderWithQueryClient(<CorrectDestinationPanel emailId="e1" decision={decision} />);

    expect(screen.getByText("Wrong place?")).toBeInTheDocument();
    expect(screen.getByText(/Now: "Spam"/)).toBeInTheDocument();
    await correctTo("Sales");

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/v1/emails/e1/correct")).toBe(true));
    const post = fetchMock.mock.calls.find(([u]) => u === "/api/v1/emails/e1/correct")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ destinationRef: "Sales" });

    expect(await screen.findByText("Stop this happening again")).toBeInTheDocument();
    const draftCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/api/v1/emails/e1/correction-rule"))!;
    const query = new URL(String(draftCall[0]), "http://x").searchParams;
    expect(query.get("destinationRef")).toBe("Sales");
    expect(query.get("wrong")).toBe("Spam");

    expect(screen.getByText("Moved back and sent to \"Sales\".")).toBeInTheDocument();
    expect(screen.getByText(/from = bob@acme.com|from equals bob@acme.com/)).toBeInTheDocument();
    expect(screen.getByText("2 other recent emails from this sender went to \"Spam\" too.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create this rule" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/v1/rules" && i?.method === "POST")).toBe(true));
    const create = fetchMock.mock.calls.find(([u, i]) => u === "/api/v1/rules" && i?.method === "POST")!;
    expect(JSON.parse(String(create[1]!.body))).toEqual(draft.rule);
    expect(await screen.findByRole("link", { name: "Open the rule" })).toHaveAttribute("href", "/rules/rule-new");
  });

  it("does not load the draft without rules:read", async () => {
    const fetchMock = stubApi();
    granted.add("emails:reprocess");
    renderWithQueryClient(<CorrectDestinationPanel emailId="e1" decision={decision} />);
    await correctTo("Sales");
    expect(await screen.findByText("Moved back and sent to \"Sales\".")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("correction-rule"))).toBe(false);
    expect(screen.queryByText("Stop this happening again")).not.toBeInTheDocument();
  });

  it("shows the API error when the correction is refused", async () => {
    const fetchMock = stubApi();
    granted.add("emails:reprocess");
    fetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith("/api/v1/destinations")) return jsonResponse({ data: [{ id: "dst1", name: "Sales" }], pagination: { hasMore: false, nextCursor: null } });
      return jsonResponse({ error: { code: "INVALID_STATE", message: "The email could not be moved back; nothing changed.", requestId: "r" } }, 409);
    });
    renderWithQueryClient(<CorrectDestinationPanel emailId="e1" decision={decision} />);
    await correctTo("Sales");
    expect(await screen.findByRole("alert")).toHaveTextContent("The email could not be moved back; nothing changed.");
  });
});
