import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrganizationCacheReset } from "@/app/providers";
import { setCurrentOrganizationId } from "@/lib/currentOrganization";

describe("OrganizationCacheReset", () => {
  it("drops the previous organization's cached lists on switch, keeps organization-independent data", async () => {
    setCurrentOrganizationId("org-a");
    const client = new QueryClient();
    client.setQueryData(["reviews", { status: "open" }], { data: ["a's item"] });
    client.setQueryData(["emails", {}], { data: ["a's email"] });
    client.setQueryData(["auth", "me"], { user: "me" });
    client.setQueryData(["organizations"], { data: ["a", "b"] });
    render(
      <QueryClientProvider client={client}>
        <OrganizationCacheReset />
      </QueryClientProvider>,
    );
    expect(client.getQueryData(["reviews", { status: "open" }])).toEqual({ data: ["a's item"] }); // no switch yet

    await act(async () => setCurrentOrganizationId("org-b"));
    expect(client.getQueryData(["reviews", { status: "open" }])).toBeUndefined();
    expect(client.getQueryData(["emails", {}])).toBeUndefined();
    expect(client.getQueryData(["auth", "me"])).toEqual({ user: "me" });
    expect(client.getQueryData(["organizations"])).toEqual({ data: ["a", "b"] });
    setCurrentOrganizationId(null);
  });
});
