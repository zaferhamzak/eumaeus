import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AlertsCard } from "@/components/overview/AlertsCard";
import { renderWithQueryClient } from "../testUtils";
import { I18nProvider } from "@/lib/i18n/I18nProvider";

let allowed = true;
vi.mock("@/hooks/useAuth", () => ({ useHasPermission: () => allowed }));

const alert = { id: "a1", kind: "mailbox_sync_failing", subjectKey: "m1", status: "open", title: "Box can't be synced", detail: "Command failed", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), resolvedAt: null, dismissedAt: null, dismissedBy: null };

afterEach(() => vi.unstubAllGlobals());

describe("AlertsCard — dismiss", () => {
  it("dismisses an alert, which then leaves the card", async () => {
    allowed = true;
    let dismissed = false;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "POST") {
          dismissed = true;
          return new Response(JSON.stringify({ ...alert, status: "dismissed" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ data: dismissed ? [] : [alert] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    renderWithQueryClient(<AlertsCard />);
    expect(await screen.findByText("Box can't be synced")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss alert: Box can't be synced" }));
    await waitFor(() => expect(calls).toContain("POST /api/v1/alerts/a1/dismiss"));
    await waitFor(() => expect(screen.queryByText("Box can't be synced")).not.toBeInTheDocument());
  });

  it("without organizations:write there is no dismiss button", async () => {
    allowed = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [alert] }), { status: 200, headers: { "content-type": "application/json" } })));
    renderWithQueryClient(<AlertsCard />);
    expect(await screen.findByText("Box can't be synced")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it("1.2: shows the alert in the viewer's language from its params; an alert saved before 1.2 keeps its stored text", async () => {
    allowed = false;
    const localized = { ...alert, id: "a2", title: "x@y.test can't be synced", detail: "old english", params: { mailbox: "x@y.test", since: "", error: "Socket timeout" } };
    const legacy = { ...alert, id: "a3", kind: "jev_errors", title: "Legacy english title", detail: "Legacy detail" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [localized, legacy] }), { status: 200, headers: { "content-type": "application/json" } })));
    renderWithQueryClient(
      <I18nProvider locale="tr">
        <AlertsCard />
      </I18nProvider>,
    );
    expect(await screen.findByText("x@y.test senkronlanamıyor")).toBeInTheDocument();
    expect(screen.getByText("Henüz başarılı bir senkron yok. Son hata: Socket timeout")).toBeInTheDocument();
    expect(screen.getByText("Legacy english title")).toBeInTheDocument();
  });
});
