import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHasPermission } from "@/hooks/useAuth";

vi.mock("@/lib/api/auth", async (orig) => ({ ...(await orig<object>()), getMe: () => new Promise(() => {}) }));

function Gated() {
  const canWrite = useHasPermission("rules:write");
  return <div>{canWrite ? <button type="button">Import JSON</button> : null}</div>;
}

const me = { user: { id: "u", email: "a@b.test", isSuperAdmin: true, mfaEnabled: false, locale: null }, memberships: [] };

/**
 * The /rules hydration error: the server rendered without /auth/me, but a
 * Suspense boundary hydrated after the sidebar had fetched it, so the client's
 * first render showed permission-gated buttons the HTML didn't have.
 */
describe("useMe during hydration", () => {
  it("matches the server HTML even when the client already has /auth/me cached", async () => {
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <Gated />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("Import JSON");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const client = new QueryClient();
    client.setQueryData(["auth", "me"], me);
    const onRecoverableError = vi.fn();
    await act(async () => {
      hydrateRoot(
        container,
        <QueryClientProvider client={client}>
          <Gated />
        </QueryClientProvider>,
        { onRecoverableError },
      );
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    // Right after hydration the real permissions apply.
    expect(container.textContent).toContain("Import JSON");
  });
});
