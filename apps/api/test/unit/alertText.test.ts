import { describe, expect, it } from "vitest";
import { localizedAlertText } from "../../src/modules/alerts/alertText.js";

const fmt = (iso: string) => `<${iso.slice(0, 10)}>`;

/** 1.2 (E): alert titles and details in the reader's language, from kind + params. */
describe("localized alert text", () => {
  it("builds every kind in both languages, formatting dates for the reader", () => {
    expect(localizedAlertText({ kind: "mailbox_sync_failing", params: { mailbox: "a@b.test", since: "2026-09-29T01:06:00Z", error: "Socket timeout" } }, "tr", fmt)).toEqual({
      title: "a@b.test senkronlanamıyor",
      detail: "<2026-09-29> tarihinden beri başarılı senkron yok. Son hata: Socket timeout",
    });
    expect(localizedAlertText({ kind: "mailbox_sync_failing", params: { mailbox: "a@b.test", since: "", error: "x" } }, "en", fmt)!.detail).toBe("No successful sync yet. Last error: x");
    expect(localizedAlertText({ kind: "action_failures", params: { failed: 6, total: 9 } }, "tr", fmt)!.title).toBe("Son bir saatte 9 işlemden 6 tanesi başarısız oldu");
    expect(localizedAlertText({ kind: "jev_access_denied", params: { status: "403", reason: "No credits" } }, "en", fmt)!.detail).toContain('Jev said: "No credits"');
    for (const kind of ["mailbox_reauth_required", "jev_errors", "forward_failures"]) {
      const tr = localizedAlertText({ kind, params: { mailbox: "m", errors: 1, analysed: 5, forwards: 1, digests: 0 } }, "tr", fmt)!;
      expect(tr.title).not.toMatch(/alertTitle_|\{/);
      expect(tr.detail).not.toMatch(/alertDetail_|\{/);
    }
  });

  it("alerts saved before 1.2 (no params) and unknown kinds keep their stored text", () => {
    expect(localizedAlertText({ kind: "jev_errors", params: null }, "tr", fmt)).toBeNull();
    expect(localizedAlertText({ kind: "something_new", params: { a: 1 } }, "tr", fmt)).toBeNull();
  });
});
