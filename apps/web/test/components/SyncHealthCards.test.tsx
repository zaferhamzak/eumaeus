import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQueryClient } from "../testUtils";
import { SyncHealthCards } from "@/components/system/SyncHealthCards";

const mailboxHealth = vi.fn();
const queueHealth = vi.fn();
let superAdmin = false;
vi.mock("@/hooks/useOps", () => ({
  useMailboxHealth: () => mailboxHealth(),
  useQueueHealth: (enabled: boolean) => (enabled ? queueHealth() : { isPending: true }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useHasPermission: () => true,
  useMe: () => ({ data: { user: { isSuperAdmin: superAdmin } } }),
}));

beforeEach(() => {
  superAdmin = false;
  mailboxHealth.mockReturnValue({
    isPending: false,
    isError: false,
    data: {
      data: [
        { id: "a", name: null, emailAddress: "broken@example.com", status: "active", lastSyncSuccessAt: null, lastSyncFailureAt: new Date().toISOString(), lastSyncError: "Command failed", consecutiveFailures: 4, health: "failing", live: false },
        { id: "b", name: "Sales", emailAddress: "sales@example.com", status: "active", lastSyncSuccessAt: new Date().toISOString(), lastSyncFailureAt: null, lastSyncError: null, consecutiveFailures: 0, health: "ok", live: true },
      ],
    },
  });
  queueHealth.mockReturnValue({
    isPending: false,
    isError: false,
    data: { data: [{ name: "mailbox-sync", counts: { waiting: 0, active: 1, delayed: 8, failed: 3, completed: 0 }, recentFailures: [{ id: "1", name: "sync", failedAt: null, reason: "IMAP timeout", attempts: 3 }] }] },
  });
});

describe("SyncHealthCards", () => {
  it("marks mailboxes with an open IDLE connection as live", () => {
    renderWithQueryClient(<SyncHealthCards />);
    expect(screen.getAllByText("Live")).toHaveLength(1);
  });

  it("lists mailboxes with their health and shows the failing one's error", () => {
    renderWithQueryClient(<SyncHealthCards />);
    expect(screen.getByText("broken@example.com")).toBeInTheDocument();
    expect(screen.getByText("Command failed")).toBeInTheDocument();
    expect(screen.getByText("Failed 4 times in a row")).toBeInTheDocument();
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("Job queues")).not.toBeInTheDocument();
  });

  it("shows the job queues only to the system administrator", () => {
    superAdmin = true;
    renderWithQueryClient(<SyncHealthCards />);
    expect(screen.getByText("Job queues")).toBeInTheDocument();
    expect(screen.getAllByText("mailbox-sync").length).toBeGreaterThan(0);
    expect(screen.getByText("IMAP timeout")).toBeInTheDocument();
  });
});
