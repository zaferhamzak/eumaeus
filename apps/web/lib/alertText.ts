import type { AlertResponse } from "@/types/api";
import type { MessageKey } from "@/lib/i18n/messages";
import { formatDateTime } from "@/lib/format";

const KINDS = ["mailbox_reauth_required", "mailbox_sync_failing", "action_failures", "jev_errors", "jev_access_denied", "forward_failures"] as const;
type Kind = (typeof KINDS)[number];

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * 1.2 (E): an alert's title and detail in the viewer's language, from its
 * kind and params. Alerts saved before 1.2 (no params) and kinds this build
 * doesn't know keep the stored text.
 */
export function alertText(alert: AlertResponse, t: Translate): { title: string; detail: string } {
  if (!alert.params || !(KINDS as readonly string[]).includes(alert.kind)) return { title: alert.title, detail: alert.detail };
  const kind = alert.kind as Kind;
  const params: Record<string, string | number> = Object.fromEntries(Object.entries(alert.params).map(([k, v]) => [k, typeof v === "number" ? v : String(v ?? "")]));
  if (typeof params.since === "string" && params.since) params.since = formatDateTime(params.since);
  const detailKey: MessageKey = kind === "mailbox_sync_failing" && !params.since ? "overview.alertDetail_mailbox_sync_failing_never" : (`overview.alertDetail_${kind}` as MessageKey);
  return { title: t(`overview.alertTitle_${kind}` as MessageKey, params), detail: t(detailKey, params) };
}
