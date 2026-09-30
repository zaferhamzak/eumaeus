"use client";

import type { EmailDetailResponse } from "@/types/api";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";

/**
 * §34 (security-critical): email body content is UNTRUSTED. This component
 * renders ONLY the plain-text body, as a React text child (never
 * dangerouslySetInnerHTML) — React escapes text children automatically, so
 * even a body containing literal `<script>` markup is displayed as inert
 * text, never parsed as HTML/executed. The backend's `body.html` field is
 * deliberately NEVER rendered here at all: safe HTML rendering would require
 * a real sanitization strategy (e.g. DOMPurify with a strict allowlist) that
 * hasn't been implemented or tested in this phase, and §34 explicitly
 * prefers plain-text over an unvetted HTML path.
 */
export function EmailBody({ email }: { email: EmailDetailResponse }) {
  const t = useT();
  const locale = useLocale();
  if (email.bodyPurgedAt) {
    return (
      <p className="text-sm text-foreground-subtle italic">
        {t("emails.bodyPurged", {
          date: new Date(email.bodyPurgedAt).toLocaleDateString(locale),
        })}
      </p>
    );
  }
  if (!email.body) {
    return (
      <p className="text-sm text-foreground-subtle italic">
        {t("emails.bodyNotLoaded")}
      </p>
    );
  }

  if (!email.body.text) {
    return (
      <p className="text-sm text-foreground-subtle italic">
        {t("emails.bodyNoPlainText")}
      </p>
    );
  }

  return (
    <div>
      <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
        {email.body.text}
      </pre>
      {email.body.truncated ? (
        <p className="mt-2 text-xs text-foreground-subtle">
          {t("emails.bodyTruncated")}
        </p>
      ) : null}
    </div>
  );
}
