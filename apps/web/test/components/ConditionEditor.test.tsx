import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ConditionEditor } from "@/components/rules/ConditionEditor";
import { operatorsForField } from "@/lib/ruleFields";
import type { ConditionLeaf } from "@/types/api";
import { renderWithQueryClient } from "../testUtils";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const catalog = {
  data: [
    { field: "sender.address", type: "string", source: "email" },
    { field: "answers.is_spam", type: "number", source: "jev" },
    { field: "email.business_hours", type: "boolean", source: "derived" },
    { field: "sender.emails_last_24h", type: "number", source: "derived" },
    { field: "answers.is_invoice", type: "number", source: "custom" },
    { field: "answers.team", type: "string", source: "custom" },
    { field: "answers.team.confidence", type: "number", source: "custom" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Phase 22: the editor's field list comes from GET /rules/fields, grouped by source. */
describe("ConditionEditor — field catalog", () => {
  it("lists custom fields from the API in their own group", async () => {
    const fetchMock = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse(catalog));
    vi.stubGlobal("fetch", fetchMock);
    const leaf: ConditionLeaf = {
      field: "sender.address",
      op: "==",
      value: "",
    };
    renderWithQueryClient(<ConditionEditor value={leaf} onChange={() => {}} />);

    const option = await screen.findByRole("option", {
      name: "answers.is_invoice",
    });
    expect(option.closest("optgroup")).toHaveAttribute(
      "label",
      "Your questions (custom)",
    );
    expect(
      screen
        .getByRole("option", { name: "email.business_hours" })
        .closest("optgroup"),
    ).toHaveAttribute("label", "Arrival context (derived)");
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/api/v1/rules/fields",
    );
  });

  it("offers a true/false select and only ==/!= for a boolean field, with its description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(catalog)),
    );
    const onChange = vi.fn();
    const leaf: ConditionLeaf = {
      field: "email.business_hours",
      op: "==",
      value: true,
    };
    renderWithQueryClient(<ConditionEditor value={leaf} onChange={onChange} />);

    const valueSelect = screen.getByRole("combobox", { name: /value/i });
    expect(valueSelect.tagName).toBe("SELECT");
    fireEvent.change(valueSelect, { target: { value: "false" } });
    expect(onChange).toHaveBeenCalledWith({
      field: "email.business_hours",
      op: "==",
      value: false,
    });

    const ops = Array.from(
      screen
        .getByRole("combobox", { name: /operator/i })
        .querySelectorAll("option"),
    ).map((o) => o.value);
    expect(ops).toEqual(["==", "!="]);
    expect(
      screen.getByText(
        /working hours aren't set, this condition never matches/,
      ),
    ).toBeInTheDocument();
  });

  it("starts a newly chosen boolean field at true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(catalog)),
    );
    const onChange = vi.fn();
    renderWithQueryClient(
      <ConditionEditor
        value={{ field: "sender.address", op: "==", value: "" }}
        onChange={onChange}
      />,
    );
    await screen.findByRole("option", { name: "answers.is_invoice" });
    fireEvent.change(screen.getByRole("combobox", { name: /field/i }), {
      target: { value: "email.business_hours" },
    });
    expect(onChange).toHaveBeenCalledWith({
      field: "email.business_hours",
      op: "==",
      value: true,
    });
  });

  it("falls back to the built-in list when the catalog request fails", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: "INTERNAL", message: "boom", requestId: null } },
        500,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithQueryClient(
      <ConditionEditor
        value={{ field: "sender.address", op: "==", value: "" }}
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.getByRole("option", { name: "sender.emails_last_24h" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "answers.is_invoice" }),
    ).not.toBeInTheDocument();
  });
});

describe("operatorsForField", () => {
  it("follows the field type from the catalog", () => {
    const fields = catalog.data as Parameters<typeof operatorsForField>[1];
    expect(operatorsForField("answers.team", fields)).toEqual([
      "==",
      "!=",
      "in",
      "contains",
    ]);
    expect(operatorsForField("answers.is_invoice", fields)).toEqual([
      "==",
      "!=",
      ">=",
      "<=",
      ">",
      "<",
      "in",
    ]);
    expect(operatorsForField("sender.first_email")).toEqual(["==", "!="]);
  });
});
