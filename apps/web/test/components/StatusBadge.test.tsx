import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/ui/StatusBadge";

/** §6/§45 item: "do not collapse all of these into a generic green/red badge" — every distinct backend state must render its OWN distinct label. */
describe("StatusBadge", () => {
  it("gives failed, ambiguous, and pending each a visibly distinct label (never merged into one generic badge)", () => {
    const { rerender } = render(<StatusBadge status="failed" />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    rerender(<StatusBadge status="ambiguous" />);
    expect(screen.getByText("Ambiguous")).toBeInTheDocument();
    rerender(<StatusBadge status="pending" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    rerender(<StatusBadge status="succeeded" />);
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
  });

  it("distinguishes every RoutingDecision status", () => {
    const { rerender } = render(<StatusBadge status="matched" />);
    expect(screen.getByText("Matched")).toBeInTheDocument();
    rerender(<StatusBadge status="unmatched" />);
    expect(screen.getByText("Unmatched")).toBeInTheDocument();
    rerender(<StatusBadge status="human_review_forced" />);
    expect(screen.getByText("Human review forced")).toBeInTheDocument();
  });

  it("falls back to the raw string for an unrecognized status, rather than crashing or hiding it", () => {
    render(<StatusBadge status="some_future_state" />);
    expect(screen.getByText("some_future_state")).toBeInTheDocument();
  });
});
