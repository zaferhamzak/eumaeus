import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SenderAuthBadge } from "@/components/email/SenderAuthBadge";
import { renderWithQueryClient } from "../testUtils";

describe("SenderAuthBadge (Phase 27)", () => {
  it("renders nothing for mail ingested before the verdict was captured", () => {
    const { container } = renderWithQueryClient(<SenderAuthBadge captured={false} auth={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the headline and each method", () => {
    renderWithQueryClient(<SenderAuthBadge captured auth={{ source: "authentication-results", authservId: "mx.google.com", spf: "pass", dkim: "fail", dmarc: "fail", authenticated: false }} />);
    expect(screen.getByText("Sender not verified")).toBeInTheDocument();
    expect(screen.getByText("SPF pass")).toBeInTheDocument();
    expect(screen.getByText("DMARC fail")).toBeInTheDocument();
    expect(screen.getByText("checked by mx.google.com")).toBeInTheDocument();
  });

  it("says when the provider stamped no verdict", () => {
    renderWithQueryClient(<SenderAuthBadge captured auth={null} />);
    expect(screen.getByText("Sender verification unknown")).toBeInTheDocument();
  });
});
