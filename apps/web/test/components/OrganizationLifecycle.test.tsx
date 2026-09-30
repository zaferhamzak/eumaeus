import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { OrganizationLifecycle } from "@/components/organizations/OrganizationLifecycle";
import { renderWithQueryClient } from "../testUtils";
import type { OrganizationResponse } from "@/types/api";

const setActive = vi.fn();
const remove = vi.fn();
const push = vi.fn();
let superAdmin = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/useAuth", () => ({ useMe: () => ({ data: { user: { isSuperAdmin: superAdmin } } }), useOrgPermissions: () => ["organizations:delete"] }));
vi.mock("@/hooks/useOrganizations", () => ({
  useSetOrganizationActive: () => ({ mutate: setActive, isPending: false, error: null }),
  useDeleteOrganizationPermanently: () => ({ mutate: remove, isPending: false, error: null }),
}));

const org = (status: string) => ({ id: "o1", name: "Deneme Org", status }) as unknown as OrganizationResponse;

afterEach(() => {
  setActive.mockReset();
  remove.mockReset();
  superAdmin = true;
});

describe("OrganizationLifecycle", () => {
  it("an active organization can only be deactivated (after confirming)", () => {
    renderWithQueryClient(<OrganizationLifecycle organization={org("active")} />);
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate organization" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Deactivate organization" }).at(-1)!);
    expect(setActive).toHaveBeenCalledWith(false, expect.anything());
  });

  it("a deactivated one can be reactivated, or deleted once its name is typed", () => {
    renderWithQueryClient(<OrganizationLifecycle organization={org("disabled")} />);
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(setActive).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const confirm = screen.getAllByRole("button", { name: "Delete permanently" }).at(-1)!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "deneme" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "deneme org" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(remove).toHaveBeenCalledWith("deneme org", expect.anything());
  });

  it("only the system administrator sees permanent deletion", () => {
    superAdmin = false;
    renderWithQueryClient(<OrganizationLifecycle organization={org("disabled")} />);
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });
});
