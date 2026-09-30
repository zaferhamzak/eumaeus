import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RuleImportExport } from "@/components/rules/RuleImportExport";
import { renderWithQueryClient } from "../testUtils";

const rules = [{ name: "Spam", priority: 1, destinationRef: "junk", conditions: { field: "answers.is_spam", op: ">=", value: 0.8 } }];

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

/** Phase 19: import always checks first; Import stays disabled until a check passes. */
describe("RuleImportExport", () => {
  it("checks, shows warnings, then imports", async () => {
    const calls: Array<{ dryRun: boolean }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        return respond({
          dryRun: body.dryRun,
          valid: true,
          created: body.dryRun ? 0 : 1,
          deactivated: 0,
          rules: [{ name: "Spam", priority: 10, destinationRef: "junk" }],
          errors: [],
          warnings: [{ index: 0, name: "Spam", message: 'destination "junk" doesn\'t exist here yet' }],
        });
      }),
    );
    renderWithQueryClient(<RuleImportExport canWrite canDelete={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toBeDisabled();
    expect(screen.getByRole("option", { name: /Replace the current rules/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Rules JSON"), { target: { value: JSON.stringify(rules) } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/1 rule ready to import/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't exist here yet/)).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ dryRun: true, mode: "add", priorities: "append" });

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Imported 1 rule.")).toBeInTheDocument();
    expect(calls[1]).toMatchObject({ dryRun: false });
  });

  it("rejects text that isn't JSON without calling the API, and hides Import without permission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderWithQueryClient(<RuleImportExport canWrite canDelete />);
    fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(screen.getByLabelText("Rules JSON"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This isn't valid JSON."));
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    renderWithQueryClient(<RuleImportExport canWrite={false} canDelete={false} />);
    expect(screen.queryByRole("button", { name: "Import JSON" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeInTheDocument();
  });
});
