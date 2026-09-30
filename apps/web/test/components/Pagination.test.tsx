import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "@/components/ui/Pagination";

describe("Pagination — cursor-only (§5/§29: never a page-number UI)", () => {
  it("shows 'Load more' when hasMore is true, and calls onLoadMore when clicked", async () => {
    const onLoadMore = vi.fn();
    const user = userEvent.setup();
    render(<Pagination hasMore loading={false} onLoadMore={onLoadMore} />);
    await user.click(screen.getByRole("button", { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("shows an end-of-results message, with no button, when hasMore is false", () => {
    render(<Pagination hasMore={false} loading={false} onLoadMore={() => {}} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/end of results/i)).toBeInTheDocument();
  });

  it("disables the button while a fetch is in flight, rather than allowing duplicate requests", () => {
    render(<Pagination hasMore loading={true} onLoadMore={() => {}} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
