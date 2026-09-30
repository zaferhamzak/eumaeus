import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetSecretForm } from "@/components/destinations/SetSecretForm";
import { renderWithQueryClient } from "../testUtils";

/**
 * §19/§45 adversarial items #2/#3 ("secret leakage into browser state",
 * "secret leakage into URLs") — the highest-risk form in the app.
 */
describe("SetSecretForm — secret handling safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a password-type input (never plain text) for the secret value", () => {
    renderWithQueryClient(<SetSecretForm destinationId="dest-1" />);
    const valueInput = screen.getByLabelText(/value/i) as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    expect(valueInput.autocomplete).toBe("off");
  });

  it("never includes the secret value in the request URL — it goes in the JSON body only, and the URL path is only the destination id + secret NAME", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "s1", destinationId: "dest-1", name: "signing_key", createdAt: "now", updatedAt: "now" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithQueryClient(<SetSecretForm destinationId="dest-1" />);
    await user.type(screen.getByLabelText(/secret name/i), "signing_key");
    await user.type(screen.getByLabelText(/value/i), "extremely-secret-value-12345");
    await user.click(screen.getByRole("button", { name: /set secret/i }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("extremely-secret-value-12345");
    expect(url).toBe("/api/v1/destinations/dest-1/secrets/signing_key");
    expect(String(init.body)).toContain("extremely-secret-value-12345"); // the ONLY place it may appear: the JSON request body
  });

  it("never renders the secret value anywhere in the DOM after a successful submit — only a 'configured' confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "s1", destinationId: "dest-1", name: "signing_key", createdAt: "now", updatedAt: "now" }), { status: 200 })),
    );
    const user = userEvent.setup();
    const secretValue = "super-recognizable-secret-xyz";

    renderWithQueryClient(<SetSecretForm destinationId="dest-1" />);
    await user.type(screen.getByLabelText(/secret name/i), "signing_key");
    await user.type(screen.getByLabelText(/value/i), secretValue);
    await user.click(screen.getByRole("button", { name: /set secret/i }));

    expect(await screen.findByText(/configured/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secretValue);
  });

  it("clears the input (uncontrolled form reset) after a successful submit — the value does not linger in the DOM input either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "s1", destinationId: "dest-1", name: "signing_key", createdAt: "now", updatedAt: "now" }), { status: 200 })),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<SetSecretForm destinationId="dest-1" />);
    const valueInput = screen.getByLabelText(/value/i) as HTMLInputElement;
    await user.type(screen.getByLabelText(/secret name/i), "signing_key");
    await user.type(valueInput, "another-secret-value");
    await user.click(screen.getByRole("button", { name: /set secret/i }));

    await screen.findByText(/configured/i);
    expect(valueInput.value).toBe("");
  });

  it("a failed submission never leaks internal error detail, only the backend's own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "RESOURCE_NOT_FOUND", message: "Destination dest-1 not found", requestId: "req-1" } }), { status: 404 })),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<SetSecretForm destinationId="dest-1" />);
    await user.type(screen.getByLabelText(/secret name/i), "signing_key");
    await user.type(screen.getByLabelText(/value/i), "irrelevant-value");
    await user.click(screen.getByRole("button", { name: /set secret/i }));

    expect(await screen.findByText("Destination dest-1 not found")).toBeInTheDocument();
  });
});
