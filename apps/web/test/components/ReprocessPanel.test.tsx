import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ReprocessPanel } from "@/components/email/ReprocessPanel";
import { renderWithQueryClient } from "../testUtils";

vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => true }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function confirmReprocess() {
  fireEvent.click(screen.getByRole("button", { name: "Reprocess" }));
  const buttons = screen.getAllByRole("button", { name: "Reprocess" });
  fireEvent.click(buttons[buttons.length - 1]!);
}

/** Phase 22: "Ask Jev again" sends reanalyze:true; off by default. */
describe("ReprocessPanel — ask Jev again", () => {
  it("sends reanalyze:false by default and true when checked", async () => {
    const fetchMock = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async () =>
      jsonResponse(
        {
          error: {
            code: "CONFLICT",
            message: "This email's content was removed by retention.",
            requestId: "r1",
          },
        },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithQueryClient(<ReprocessPanel emailId="e1" previous={[]} />);

    const checkbox = screen.getByRole("checkbox", { name: /ask jev again/i });
    expect(checkbox).not.toBeChecked();

    confirmReprocess();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/emails/e1/reprocess");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      reanalyze: false,
    });

    fireEvent.click(checkbox);
    confirmReprocess();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      reanalyze: true,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This email's content was removed by retention.",
    );
  });
});
