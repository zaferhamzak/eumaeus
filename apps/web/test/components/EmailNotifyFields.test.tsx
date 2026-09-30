import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQueryClient } from "../testUtils";
import { EmailNotifyFields, readEmailNotifyConfig } from "@/components/destinations/EmailNotifyFields";

const previewNotice = vi.fn();
const sendTestNotice = vi.fn();
vi.mock("@/lib/api/destinations", () => ({
  previewNotice: (input: unknown) => previewNotice(input),
  sendTestNotice: (input: unknown) => sendTestNotice(input),
}));
vi.mock("@/hooks/useAuth", () => ({
  useMembers: () => ({
    isPending: false,
    data: {
      data: [
        { userId: "u1", email: "alice@team.test", status: "active", permissions: [] },
        { userId: "u2", email: "gone@team.test", status: "revoked", permissions: [] },
      ],
    },
  }),
}));
vi.mock("@/lib/currentOrganization", () => ({ useCurrentOrganizationId: () => "org-1" }));

beforeEach(() => {
  previewNotice.mockReset();
  sendTestNotice.mockReset();
});

function renderInForm(initialConfig?: Record<string, unknown>) {
  return renderWithQueryClient(
    <form data-testid="form">
      <EmailNotifyFields initialConfig={initialConfig} destinationName="Faturalar" />
    </form>,
  );
}

const read = () => readEmailNotifyConfig(new FormData(screen.getByTestId("form") as HTMLFormElement));

describe("Email notification channel fields (1.2 O)", () => {
  it("lists only active members and reads the form back into a channel config", () => {
    renderInForm();
    expect(screen.getByText("alice@team.test")).toBeInTheDocument();
    expect(screen.queryByText("gone@team.test")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "alice@team.test" }));
    fireEvent.change(screen.getByLabelText(/^Everyone who…/), { target: { value: "reviews:resolve" } });
    fireEvent.change(screen.getByLabelText(/^Outside addresses \(optional\)/), { target: { value: "boss@out.test, ops@out.test" } });
    fireEvent.change(screen.getByLabelText("Send"), { target: { value: "throttle" } });
    fireEvent.change(screen.getByLabelText("At most once per"), { target: { value: "30" } });
    expect(read()).toEqual({ members: ["u1"], permission: "reviews:resolve", addresses: ["boss@out.test", "ops@out.test"], delivery: "throttle", throttleMinutes: 30 });
  });

  it("keeps a saved config when editing", () => {
    renderInForm({ members: ["u1"], delivery: "digest", digestIntervalMinutes: 240, includeExcerpt: true, subjectTemplate: "[{category}] {subject}" });
    expect(read()).toEqual({ members: ["u1"], delivery: "digest", digestIntervalMinutes: 240, includeExcerpt: true, subjectTemplate: "[{category}] {subject}" });
  });

  it("previews the notice for the current settings and can mail a test to me", async () => {
    previewNotice.mockResolvedValue({ emailId: "e1", subject: "Faturalar: Invoice 7", html: "<p>notice</p>", text: "notice" });
    sendTestNotice.mockResolvedValue({ to: "me@team.test", sent: true, error: null, subject: "Faturalar: Invoice 7" });
    renderInForm({ members: ["u1"] });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByText("Faturalar: Invoice 7")).toBeInTheDocument());
    expect(previewNotice).toHaveBeenCalledWith({ config: { members: ["u1"] }, destinationName: "Faturalar" });
    expect(screen.getByTitle("Preview")).toHaveAttribute("sandbox", "");

    fireEvent.click(screen.getByRole("button", { name: "Send me a test" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent to me@team.test."));
  });
});
