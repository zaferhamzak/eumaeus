import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { ApiRequestError } from "@/lib/api/client";

/** §36/§37/§38: an error is not an empty state, and neither is silently showing nothing while loading. */
describe("EmptyState / ErrorState / LoadingState", () => {
  it("EmptyState renders the specific copy passed to it (never a generic 'Nothing here')", () => {
    render(<EmptyState title="No emails have been processed yet." />);
    expect(screen.getByText("No emails have been processed yet.")).toBeInTheDocument();
  });

  it("ErrorState shows the backend's human message and request id, and an accessible alert role", () => {
    const error = new ApiRequestError("Destination not found", "RESOURCE_NOT_FOUND", 404, "req-abc-123");
    render(<ErrorState error={error} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Destination not found")).toBeInTheDocument();
    expect(screen.getByText(/req-abc-123/)).toBeInTheDocument();
  });

  it("ErrorState's Retry button calls the supplied retry handler", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState error={new Error("boom")} onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("ErrorState never renders a raw stack trace even if the underlying error has one", () => {
    const error = new Error("boom");
    render(<ErrorState error={error} />);
    expect(document.body.textContent).not.toContain(error.stack);
  });

  it("LoadingState announces itself for assistive tech (role=status)", () => {
    render(<LoadingState label="Loading emails…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading emails…");
  });
});
