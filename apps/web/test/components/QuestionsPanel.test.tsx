import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { QuestionsPanel } from "@/components/organizations/QuestionsPanel";
import { renderWithQueryClient } from "../testUtils";

let permissions: string[] = [];
vi.mock("@/hooks/useAuth", () => ({ useOrgPermissions: () => permissions }));

afterEach(() => vi.unstubAllGlobals());

const existing = {
  id: "q-1",
  key: "needs_invoice",
  field: "answers.needs_invoice",
  type: "noul",
  instructions: "Is the sender asking for an invoice?",
  criteria: { true: "They ask for an invoice" },
  createdBy: "admin@example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  usedBy: ["Invoices to finance"],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; method: string; body: unknown; org: string | null };

function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        org: new Headers(init.headers).get("X-Organization-Id"),
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

/** Phase 22: the organization's own Jev questions. */
describe("QuestionsPanel", () => {
  it("creates a choice question with its options as criteria", async () => {
    permissions = ["rules:read", "rules:write"];
    const calls = stubFetch((call) =>
      call.method === "POST" ? json({ ...existing, id: "q-2" }, 201) : json({ data: [existing], limit: 20 }),
    );
    renderWithQueryClient(<QuestionsPanel organizationId="org-1" />);
    expect(await screen.findByText("answers.needs_invoice")).toBeInTheDocument();
    expect(screen.getByText("1 of 20")).toBeInTheDocument();
    expect(screen.getByText("Used by: Invoices to finance")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "department" } });
    fireEvent.change(screen.getByLabelText("Answer type"), { target: { value: "choice" } });
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Which department is this for?" } });
    fireEvent.change(screen.getByLabelText("Option 1 key"), { target: { value: "sales" } });
    fireEvent.change(screen.getByLabelText("Option 1 description"), { target: { value: "Buying or pricing" } });
    fireEvent.change(screen.getByLabelText("Option 2 key"), { target: { value: "support" } });
    fireEvent.change(screen.getByLabelText("Option 2 description"), { target: { value: "Help with a product" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByLabelText("Option 3 key"), { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("Option 3 description"), { target: { value: "Anything else" } });
    fireEvent.click(screen.getByRole("button", { name: "Create question" }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/questions");
    expect(post.org).toBe("org-1");
    expect(post.body).toEqual({
      key: "department",
      type: "choice",
      instructions: "Which department is this for?",
      criteria: { sales: "Buying or pricing", support: "Help with a product", other: "Anything else" },
    });
  });

  it("on 409 shows the rules using the question and can delete anyway", async () => {
    permissions = ["rules:read", "rules:write"];
    const calls = stubFetch((call) => {
      if (call.method === "DELETE" && !call.url.includes("force=true"))
        return json({ error: { code: "CONFLICT", message: "Question is in use", requestId: "r1", details: { usedBy: ["Invoices to finance", "VIP graph"] } } }, 409);
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      return json({ data: [existing], limit: 20 });
    });
    renderWithQueryClient(<QuestionsPanel organizationId="org-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const alert = await screen.findByText("This question is still used by:");
    const box = alert.closest("[role=alert]") as HTMLElement;
    expect(within(box).getByText("VIP graph")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe("/api/v1/questions/q-1");

    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2));
    const forced = calls.filter((c) => c.method === "DELETE")[1]!;
    expect(forced.url).toBe("/api/v1/questions/q-1?force=true");
    expect(forced.org).toBe("org-1");
  });

  it("without rules:write there is no create form", async () => {
    permissions = ["rules:read"];
    stubFetch(() => json({ data: [], limit: 20 }));
    renderWithQueryClient(<QuestionsPanel organizationId="org-1" />);
    expect(await screen.findByText(/You need rules:write/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create question" })).not.toBeInTheDocument();
  });
});
