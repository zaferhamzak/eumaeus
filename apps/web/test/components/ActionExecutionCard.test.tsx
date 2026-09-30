import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionExecutionCard } from "@/components/email/ActionExecutionCard";
import { renderWithQueryClient } from "../testUtils";
import { makeActionExecution } from "../fixtures";

// The card also checks the undo permission (Phase 15); isolate it from the
// /auth/me request so these tests only see the retry endpoint's traffic.
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => false }));

/**
 * §13/§45 adversarial item #8 ("retrying terminal actions incorrectly") — the
 * Retry button must appear ONLY for status="failed" && retryable=true, never
 * for succeeded/ambiguous/permanently-failed executions. §45 item #16 ("action
 * ambiguity displayed as failure") — ambiguous must render its own distinct
 * message, never be conflated with "failed".
 */
describe("ActionExecutionCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Retry for a genuinely retryable failure", () => {
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "failed", retryable: true })} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does NOT show Retry for a succeeded execution", () => {
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "succeeded", retryable: null, errorMessage: null })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("does NOT show Retry for an ambiguous execution, and shows the distinct ambiguous explanation (not a generic failure message)", () => {
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "ambiguous", retryable: null, errorMessage: "connection dropped mid-move" })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/may have already succeeded/i)).toBeInTheDocument();
  });

  it("does NOT show Retry for a permanently-failed (retryable=false) execution", () => {
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "failed", retryable: false })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("does NOT show Retry for a pending execution", () => {
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "pending", retryable: null, errorMessage: null, completedAt: null })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("clicking Retry requires confirmation before calling the backend retry endpoint — never fires the request on the first click", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "failed", retryable: true })} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(fetchMock).not.toHaveBeenCalled(); // confirm dialog must appear first
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not assume success merely because the retry request resolves — an error response is surfaced, not silently treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "INVALID_STATE", message: "This execution is not retryable", requestId: "req-1" } }), {
          status: 409,
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ status: "failed", retryable: true })} />);

    await user.click(screen.getByRole("button", { name: /retry/i }));
    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: /^retry$/i });
    await user.click(confirmButton);

    expect(await screen.findByText(/this execution is not retryable/i)).toBeInTheDocument();
  });
});
