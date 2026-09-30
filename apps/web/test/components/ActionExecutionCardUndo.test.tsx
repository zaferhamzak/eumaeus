import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ActionExecutionCard } from "@/components/email/ActionExecutionCard";
import { renderWithQueryClient } from "../testUtils";
import { makeActionExecution } from "../fixtures";

let allowed = true;
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => allowed }));

const move = makeActionExecution({
  id: "move-1",
  channelType: "archive",
  status: "succeeded",
  retryable: null,
  errorMessage: null,
  details: { moved: true, targetFolder: "Junk", sourceFolder: "INBOX" },
});

/** Phase 15: "Undo move" appears only for a completed move that hasn't been undone, and only with permission. */
describe("ActionExecutionCard — undo", () => {
  it("offers Undo for a completed move and says where it went", () => {
    allowed = true;
    renderWithQueryClient(<ActionExecutionCard execution={move} siblings={[move]} />);
    expect(screen.getByRole("button", { name: /undo move/i })).toBeInTheDocument();
    expect(screen.getByText(/Moved from/)).toHaveTextContent("Moved from INBOX to Junk.");
  });

  it("not once it has been undone — and marks it", () => {
    allowed = true;
    const undo = makeActionExecution({ id: "undo-1", channelType: "archive_undo", status: "succeeded", details: { undoes: "move-1", fromFolder: "Junk", toFolder: "INBOX" } });
    renderWithQueryClient(<ActionExecutionCard execution={move} siblings={[move, undo]} />);
    expect(screen.queryByRole("button", { name: /undo move/i })).not.toBeInTheDocument();
    expect(screen.getByText("undone")).toBeInTheDocument();
  });

  it("not without the permission, and never for a forward or webhook", () => {
    allowed = false;
    renderWithQueryClient(<ActionExecutionCard execution={move} siblings={[move]} />);
    expect(screen.queryByRole("button", { name: /undo move/i })).not.toBeInTheDocument();

    allowed = true;
    renderWithQueryClient(<ActionExecutionCard execution={makeActionExecution({ channelType: "forward", status: "succeeded" })} />);
    expect(screen.queryByRole("button", { name: /undo move/i })).not.toBeInTheDocument();
  });
});
