import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessingTimeline } from "@/components/email/ProcessingTimeline";
import { makeEmail, makeActionExecution } from "../fixtures";

/** §8 (adversarial item #10, "invented frontend states"): the final step's label must describe a REAL backend signal (an ActionExecution's real status, a HumanReviewItem's real status) — never a fabricated `Email.completed` state that doesn't exist on the backend. */
describe("ProcessingTimeline", () => {
  it("never renders the literal word 'Completed' as a step — that backend state does not exist", () => {
    const email = makeEmail({
      analysis: { id: "a1", emailId: "email-1", schemaVersion: "v1", jevModel: "jev-1.13.0", status: "ok", answers: {}, errorClass: null, errorMessage: null, inputTokens: 10, outputTokens: 0, latencyMs: 100, inputTruncated: false, createdAt: "2026-01-01T10:00:01.000Z" },
      routingDecision: { id: "rd1", tenantId: "t1", emailId: "email-1", status: "matched", matchedRuleId: "rule-1", matchedRuleVersion: 1, destinationRef: "sales", ruleGraphId: null, ruleGraphVersion: null, graphPath: null, senderListEntryId: null, senderListPattern: null, supersededAt: null, analysisResultId: "a1", createdAt: "2026-01-01T10:00:02.000Z" },
      actionExecutions: [makeActionExecution({ status: "succeeded", retryable: null, errorMessage: null })],
    });

    render(<ProcessingTimeline email={email} />);

    expect(screen.queryByText(/^completed$/i)).not.toBeInTheDocument();
    // The real, honest label instead:
    expect(screen.getByText(/action succeeded/i)).toBeInTheDocument();
  });

  it("labels a failed action as 'Action failed', never silently as ambiguous or hidden", () => {
    const email = makeEmail({
      routingDecision: { id: "rd1", tenantId: "t1", emailId: "email-1", status: "matched", matchedRuleId: "rule-1", matchedRuleVersion: 1, destinationRef: "sales", ruleGraphId: null, ruleGraphVersion: null, graphPath: null, senderListEntryId: null, senderListPattern: null, supersededAt: null, analysisResultId: null, createdAt: "2026-01-01T10:00:02.000Z" },
      actionExecutions: [makeActionExecution({ status: "failed", retryable: true })],
    });
    render(<ProcessingTimeline email={email} />);
    expect(screen.getByText(/action failed/i)).toBeInTheDocument();
  });

  it("shows 'No rule matched' plainly for an unmatched routing decision, not a generic error", () => {
    const email = makeEmail({
      routingDecision: { id: "rd1", tenantId: "t1", emailId: "email-1", status: "unmatched", matchedRuleId: null, matchedRuleVersion: null, destinationRef: null, ruleGraphId: null, ruleGraphVersion: null, graphPath: null, senderListEntryId: null, senderListPattern: null, supersededAt: null, analysisResultId: "a1", createdAt: "2026-01-01T10:00:02.000Z" },
    });
    render(<ProcessingTimeline email={email} />);
    expect(screen.getByText(/no rule matched/i)).toBeInTheDocument();
  });

  it("shows a review step distinctly for open vs resolved Human Review items", () => {
    const openEmail = makeEmail({
      reviewItems: [
        { id: "r1", tenantId: "t1", emailId: "email-1", reason: "unmatched", status: "open", resolution: null, assignedTo: null, resolvedAt: null, createdAt: "2026-01-01T10:00:02.000Z", emailPreview: null, signal: null },
      ],
    });
    const { rerender } = render(<ProcessingTimeline email={openEmail} />);
    expect(screen.getByText(/awaiting human review/i)).toBeInTheDocument();

    const resolvedEmail = makeEmail({
      reviewItems: [
        { id: "r1", tenantId: "t1", emailId: "email-1", reason: "unmatched", status: "resolved", resolution: null, assignedTo: null, resolvedAt: "2026-01-01T11:00:00.000Z", createdAt: "2026-01-01T10:00:02.000Z", emailPreview: null, signal: null },
      ],
    });
    rerender(<ProcessingTimeline email={resolvedEmail} />);
    expect(screen.getByText(/resolved by human review/i)).toBeInTheDocument();
  });
});
