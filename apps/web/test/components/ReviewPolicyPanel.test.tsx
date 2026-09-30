import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ReviewPolicyPanel } from "@/components/organizations/ReviewPolicyPanel";
import { renderWithQueryClient } from "../testUtils";
import type { OrganizationResponse } from "@/types/api";

const mutate = vi.fn();
vi.mock("@/hooks/useAuth", () => ({ useOrgPermissions: () => ["organizations:write"] }));
vi.mock("@/hooks/useOrganizations", () => ({ useUpdateOrganization: () => ({ mutate, isPending: false, isError: false, isSuccess: false }) }));

const org = {
  id: "o1",
  humanReviewSignalEnabled: true,
  humanReviewSignalThreshold: 0.5,
  reviewDigestEnabled: false,
  reviewDigestIntervalMinutes: 60,
  lastReviewDigestAt: null,
  assignmentNotifyEnabled: true,
  assignmentNotifyThreshold: 1,
} as unknown as OrganizationResponse;

afterEach(() => mutate.mockReset());

describe("ReviewPolicyPanel — assignment email threshold", () => {
  it("saves a threshold of 10 and explains it", () => {
    renderWithQueryClient(<ReviewPolicyPanel organization={org} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
    expect(screen.getByText(/One email once 10 items/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ assignmentNotifyEnabled: true, assignmentNotifyThreshold: 10 }));
  });

  it("refuses an out-of-range threshold", () => {
    renderWithQueryClient(<ReviewPolicyPanel organization={org} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    expect(screen.getByRole("alert")).toHaveTextContent("1 to 100");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
