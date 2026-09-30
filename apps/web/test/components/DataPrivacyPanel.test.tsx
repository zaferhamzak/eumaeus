import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { DataPrivacyPanel } from "@/components/organizations/DataPrivacyPanel";
import { renderWithQueryClient } from "../testUtils";
import type { OrganizationResponse } from "@/types/api";

let permissions: string[] = [];
vi.mock("@/hooks/useAuth", () => ({ useOrgPermissions: () => permissions }));

const org = { id: "org-1", bodyRetentionDays: null, emailRetentionDays: 365 } as unknown as OrganizationResponse;

afterEach(() => vi.unstubAllGlobals());

/** Phase 20: erasing a sender is a find → confirm-by-retyping → erase flow, sent to the page's organization. */
describe("DataPrivacyPanel", () => {
  it("finds first, requires the address to be retyped, and targets this organization", async () => {
    permissions = ["organizations:write", "privacy:erase"];
    const calls: Array<{ body: { dryRun: boolean }; org: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ body, org: new Headers(init.headers).get("X-Organization-Id") });
        return new Response(JSON.stringify({ dryRun: body.dryRun, address: "ayse@example.com", emails: 3, autoReplyRecords: 1, suggestions: 0, senderListEntries: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderWithQueryClient(<DataPrivacyPanel organization={org} />);
    expect(screen.getByLabelText("Email retention days")).toHaveValue(365);

    fireEvent.change(screen.getByLabelText("Sender address"), { target: { value: "ayse@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/3 emails, 1 auto-reply record and 0 suggestions will be deleted/)).toBeInTheDocument();
    expect(screen.getByText(/also on the allow\/block list/)).toBeInTheDocument();
    expect(calls[0]).toEqual({ body: { address: "ayse@example.com", dryRun: true }, org: "org-1" });

    const erase = screen.getByRole("button", { name: "Erase permanently" });
    expect(erase).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm address"), { target: { value: "AYSE@example.com" } });
    expect(erase).toBeEnabled();
    fireEvent.click(erase);
    expect(await screen.findByText("Erased 3 emails from ayse@example.com.")).toBeInTheDocument();
    expect(calls[1]!.body.dryRun).toBe(false);
  });

  it("without privacy:erase there is no erase form", () => {
    permissions = ["organizations:write"];
    renderWithQueryClient(<DataPrivacyPanel organization={org} />);
    expect(screen.queryByLabelText("Sender address")).not.toBeInTheDocument();
    expect(screen.getByText(/You need privacy:erase/)).toBeInTheDocument();
  });
});
