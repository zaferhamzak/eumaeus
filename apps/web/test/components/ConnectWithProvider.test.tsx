import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ConnectWithProvider } from "@/components/mailboxes/ConnectWithProvider";
import { renderWithQueryClient } from "../testUtils";

const mutate = vi.fn();
let providers: { google: boolean; microsoft: boolean } | undefined = { google: false, microsoft: false };
let superAdmin = true;
vi.mock("@/hooks/useMailboxes", () => ({
  useOAuthProviders: () => ({ data: providers }),
  useStartMailboxOAuth: () => ({ mutate, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useAuth", () => ({ useMe: () => ({ data: { user: { isSuperAdmin: superAdmin } } }) }));

afterEach(() => {
  mutate.mockReset();
  providers = { google: false, microsoft: false };
  superAdmin = true;
});

describe("ConnectWithProvider", () => {
  it("shows Connect Gmail even when Google isn't set up, and explains the setup to the super admin", () => {
    renderWithQueryClient(<ConnectWithProvider />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/isn't set up yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Mailbox sign-in/ })).toHaveAttribute("href", "/settings#mailbox-sign-in");
  });

  it("tells other members to ask the administrator", () => {
    superAdmin = false;
    renderWithQueryClient(<ConnectWithProvider />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(screen.getByText(/system administrator can turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("starts the sign-in when Google is set up", () => {
    providers = { google: true, microsoft: false };
    renderWithQueryClient(<ConnectWithProvider />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(mutate).toHaveBeenCalledWith({ provider: "google" });
  });

  it("on an organization's page, adds to that organization and comes back to it", () => {
    providers = { google: true, microsoft: false };
    renderWithQueryClient(<ConnectWithProvider organizationId="org-2" align="start" />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(mutate).toHaveBeenCalledWith({ provider: "google", organizationId: "org-2", returnTo: "organization" });
  });
});
