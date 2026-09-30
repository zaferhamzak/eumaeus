import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQueryClient } from "../testUtils";
import OutboundPage from "@/app/outbound/page";

const calls: Array<{ filters: unknown; all: boolean }> = [];
let superAdmin = false;
vi.mock("@/hooks/useOutbound", () => ({
  useOutboundEmails: (filters: unknown, all: boolean) => {
    calls.push({ filters, all });
    return {
      isPending: false,
      isError: false,
      isFetchingNextPage: false,
      data: {
        pages: [
          {
            data: [
              { id: "1", kind: "alert", toAddress: "ops@x.test", subject: "Box down", status: "sent", error: null, messageId: "<m>", relatedId: "a1", createdAt: new Date().toISOString(), ...(all ? { organization: null } : {}) },
              { id: "2", kind: "forward", toAddress: "b@x.test", subject: "Fwd: invoice", status: "failed", error: "550 mailbox unavailable", messageId: null, relatedId: "e1", createdAt: new Date().toISOString() },
            ],
            pagination: { hasMore: false, nextCursor: null },
          },
        ],
      },
    };
  },
}));
vi.mock("@/hooks/useAuth", () => ({
  useHasPermission: () => true,
  useMe: () => ({ data: { user: { isSuperAdmin: superAdmin } } }),
}));

beforeEach(() => {
  calls.length = 0;
  superAdmin = false;
});

describe("Outgoing email page (1.2 F)", () => {
  it("lists sends with kind, recipient and outcome; a failed one shows its error and links to its email", () => {
    renderWithQueryClient(<OutboundPage />);
    expect(screen.getByText("Box down")).toBeInTheDocument();
    expect(screen.getByText(/Alert · To: ops@x.test/)).toBeInTheDocument();
    expect(screen.getByText("550 mailbox unavailable")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open email" })).toHaveAttribute("href", "/emails/e1");
  });

  it("only the system administrator can switch to every organization and system emails", () => {
    renderWithQueryClient(<OutboundPage />);
    expect(screen.queryByRole("option", { name: "All organizations and system emails" })).toBeNull();

    superAdmin = true;
    renderWithQueryClient(<OutboundPage />);
    fireEvent.change(screen.getByLabelText("All organizations and system emails"), { target: { value: "all" } });
    expect(calls.at(-1)).toMatchObject({ all: true });
    expect(screen.getByText(/Alert · To: ops@x.test · System/)).toBeInTheDocument();
  });

  it("filters to failed sends", () => {
    renderWithQueryClient(<OutboundPage />);
    fireEvent.change(screen.getByLabelText("Failed only"), { target: { value: "failed" } });
    expect(calls.at(-1)).toMatchObject({ filters: { status: "failed" } });
  });
});
