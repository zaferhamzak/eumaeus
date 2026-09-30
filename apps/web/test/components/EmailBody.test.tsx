import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailBody } from "@/components/email/EmailBody";
import { makeEmail } from "../fixtures";

/**
 * §34 (security-critical, adversarial audit item #1: "XSS through email
 * body"): a malicious email body containing script/HTML markup must be
 * displayed as INERT TEXT, never parsed/executed as HTML. This is the single
 * highest-risk rendering path in the whole app.
 */
describe("EmailBody — untrusted content safety", () => {
  it("renders a script-tag-containing body as literal, inert text — not executed, not parsed as an element", () => {
    const malicious = '<script>window.__xss = true;</script><img src=x onerror="window.__xss2 = true">';
    const email = makeEmail({ body: { text: malicious, html: null, truncated: false } });

    render(<EmailBody email={email} />);

    // The literal text is visible verbatim, inside the <pre> block (proves it
    // went through as a text node, not stripped) ...
    expect(screen.getByText(malicious, { selector: "pre" })).toBeInTheDocument();
    // ... and it was never actually executed as markup: no real <script> or
    // <img> element exists anywhere in the rendered tree, and the global
    // flags a real execution would have set are untouched.
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    expect((window as unknown as { __xss2?: boolean }).__xss2).toBeUndefined();
  });

  it("never renders body.html via dangerouslySetInnerHTML — html content is deliberately never used", () => {
    const email = makeEmail({
      body: { text: null, html: "<div id='from-html'>should never appear as a real element</div>", truncated: false },
    });

    render(<EmailBody email={email} />);

    // The HTML field's content must not be injected into the DOM as markup at all.
    expect(document.getElementById("from-html")).toBeNull();
  });

  it("shows a plain, honest message when body was never requested (includeBody=false)", () => {
    render(<EmailBody email={makeEmail({ body: null })} />);
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument();
  });

  it("shows truncation notice when the backend marked the body truncated, without altering the displayed text's honesty about it", () => {
    const email = makeEmail({ body: { text: "short (but the backend says it was truncated)", html: null, truncated: true } });
    render(<EmailBody email={email} />);
    expect(screen.getByText(/truncated for display/i)).toBeInTheDocument();
  });
});
