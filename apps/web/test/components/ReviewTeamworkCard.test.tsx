import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ReviewTeamworkCard } from "@/components/review/ReviewTeamworkCard";
import { renderWithQueryClient } from "../testUtils";
import type { ReviewDetailResponse } from "@/types/api";

vi.mock("@/hooks/useAuth", () => ({ useMe: () => ({ data: { user: { id: "u-me", email: "me@x.test" } } }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const review = (over: Partial<ReviewDetailResponse> = {}) =>
  ({ id: "r1", assignedTo: null, assignedToEmail: null, notes: [{ id: "n1", text: "Asked finance", author: "ali@x.test", createdAt: "2026-09-27T10:00:00Z" }], ...over }) as unknown as ReviewDetailResponse;

afterEach(() => vi.unstubAllGlobals());

describe("ReviewTeamworkCard (Phase 28)", () => {
  it("shows notes and the assignee read-only without reviews:resolve", () => {
    renderWithQueryClient(<ReviewTeamworkCard review={review({ assignedTo: "u2", assignedToEmail: "ayse@x.test" })} canResolve={false} />);
    expect(screen.getByText("Asked finance")).toBeInTheDocument();
    expect(screen.getByText("ayse@x.test")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("assigns to me and adds a note", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/reviews/assignees")) return json({ data: [{ userId: "u-me", email: "me@x.test" }, { userId: "u2", email: "ayse@x.test" }] });
      if (url.includes("/assign")) return json({ id: "r1", assignedTo: JSON.parse(String(init?.body)).userId });
      if (url.includes("/notes")) return json({ id: "n2", text: "Done", author: "me@x.test", createdAt: "2026-09-28T10:00:00Z" }, 201);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithQueryClient(<ReviewTeamworkCard review={review()} canResolve />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes("/reviews/r1/assign") && String(i?.body).includes("u-me"))).toBe(true));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Done  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes("/reviews/r1/notes") && JSON.parse(String(i?.body)).text === "Done")).toBe(true));
  });
});
