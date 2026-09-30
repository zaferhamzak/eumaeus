import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQueryClient } from "../testUtils";
import { JevStatusCard } from "@/components/system/JevStatusCard";

const mutate = vi.fn();
let status: Record<string, unknown>;
let canRetry = true;
vi.mock("@/hooks/useOps", () => ({
  useJevStatus: () => ({ isPending: false, isError: false, data: status }),
  useRetryJev: () => ({ mutate, isPending: false, data: undefined }),
}));
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: (p: string) => (p === "emails:reprocess" ? canRetry : true) }));

const healthy = { lastSuccessAt: new Date().toISOString(), lastErrorAt: null, currentError: null, accessDenied: false, waiting: 0, failed: 0, failedEmailIds: [], last7Days: { ok: 40, error: 0, inputTokens: 1000 } };

beforeEach(() => {
  mutate.mockReset();
  canRetry = true;
  status = healthy;
});

describe("Jev status card (1.2 G)", () => {
  it("on the dashboard it stays out of the way while Jev works", () => {
    const { container } = renderWithQueryClient(<JevStatusCard onlyWhenTroubled />);
    expect(container).toBeEmptyDOMElement();
    renderWithQueryClient(<JevStatusCard />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("40 ok · 0 errors")).toBeInTheDocument();
  });

  it("says plainly when Jev refuses, and asks Jev again for the emails left behind after a confirmation", () => {
    status = { ...healthy, currentError: { httpStatus: 403, message: "Free tier users do not have access to this model." }, accessDenied: true, failed: 2, failedEmailIds: ["e1", "e2"] };
    renderWithQueryClient(<JevStatusCard onlyWhenTroubled />);
    expect(screen.getByText("Refusing")).toBeInTheDocument();
    expect(screen.getByText(/Jev is refusing requests \(HTTP 403\)/)).toBeInTheDocument();
    expect(screen.getByText("“Free tier users do not have access to this model.”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ask Jev again (2)" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask Jev again" }));
    expect(mutate).toHaveBeenCalledWith(["e1", "e2"], expect.anything());
  });

  it("without emails:reprocess there is no retry button", () => {
    canRetry = false;
    status = { ...healthy, failed: 3, failedEmailIds: ["a", "b", "c"] };
    renderWithQueryClient(<JevStatusCard />);
    expect(screen.queryByRole("button", { name: /Ask Jev again/ })).toBeNull();
  });
});
