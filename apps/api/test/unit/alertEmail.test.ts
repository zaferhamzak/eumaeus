import { describe, expect, it } from "vitest";
import { buildAlertEmail } from "../../src/modules/email/alertEmail.js";
import { EMAIL_LOGO_CID } from "../../src/modules/email/emailLogo.js";

/** 1.0.2: the designed alert email. */
describe("alert email", () => {
  const base = { organizationName: "Acme", link: "https://app.test/", locale: "tr" as const, timeZone: "Europe/Istanbul" };

  it("an open alert: badge, detail, advice for its kind and a button to the page that fixes it", () => {
    const m = buildAlertEmail({ ...base, kind: "mailbox_sync_failing", title: "a@b.test can't be synced", detail: "Socket timeout", resolved: false, firstSeenAt: new Date("2026-09-29T01:06:00Z"), settingsLink: "https://app.test/organizations/o1" });
    expect(m.subject).toBe("a@b.test can't be synced (Acme, Eumaeus)");
    expect(m.html).toContain("Uyarı");
    expect(m.html).toContain("Socket timeout");
    expect(m.html).toContain("Ne yapmalı?");
    expect(m.html).toContain('href="https://app.test/mailboxes"');
    expect(m.html).toContain('href="https://app.test/organizations/o1"');
    // Times in the organization's zone: 01:06 UTC is 04:06 in Istanbul.
    expect(m.html).toContain("04:06 (Europe/Istanbul)");
    expect(m.text).toContain("Ayrıntılar: https://app.test/mailboxes");
    expect(m.text).toContain("Ne yapmalı?");
  });

  it("the logo travels as an inline image the HTML refers to by cid", () => {
    const m = buildAlertEmail({ ...base, title: "t", detail: "d", resolved: false });
    expect(m.html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
    expect(m.inlineImages).toHaveLength(1);
    expect(m.inlineImages[0]!.cid).toBe(EMAIL_LOGO_CID);
    expect(m.inlineImages[0]!.content.subarray(1, 4).toString()).toBe("PNG");
  });

  it("a reminder says it is still open; a resolved one says how long it lasted and gives no advice", () => {
    const reminder = buildAlertEmail({ ...base, kind: "jev_errors", title: "Jev errors", detail: "d", resolved: false, reminder: true });
    expect(reminder.subject).toBe("Hâlâ açık: Jev errors (Acme, Eumaeus)");
    expect(reminder.html).toContain("Hâlâ açık");

    const resolved = buildAlertEmail({ ...base, kind: "jev_errors", title: "Jev errors", detail: "secret-detail", resolved: true, firstSeenAt: new Date("2026-09-29T01:00:00Z"), resolvedAt: new Date("2026-09-29T15:00:00Z") });
    expect(resolved.subject).toBe("Çözüldü: Jev errors (Acme, Eumaeus)");
    expect(resolved.html).toContain("14 saat");
    expect(resolved.html).not.toContain("Ne yapmalı?");
    expect(resolved.html).not.toContain("secret-detail");
    expect(resolved.html).toContain('href="https://app.test/"');
  });

  it("escapes the title, detail and organization name (they can carry text from mail servers)", () => {
    const m = buildAlertEmail({ ...base, organizationName: "<i>Org</i>", title: "<script>x</script>", detail: 'server said: "<b>no</b>"', resolved: false });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>no</b>");
    expect(m.html).not.toContain("<i>Org</i>");
    expect(m.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("an unknown kind or no time zone still builds a message", () => {
    const m = buildAlertEmail({ organizationName: "Acme", link: "https://app.test", title: "t", detail: "d", resolved: false, kind: "something_new", firstSeenAt: new Date("2026-09-29T01:06:00Z") });
    expect(m.html).not.toContain("What to do");
    expect(m.html).toContain("(UTC)");
    expect(m.html).toContain('href="https://app.test/"');
  });
});
