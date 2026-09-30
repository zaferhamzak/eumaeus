import { apiRequest } from "./client";
import type { ForwardRecipientResponse } from "@/types/api";

export function listForwardRecipients(signal?: AbortSignal) {
  return apiRequest<{ data: ForwardRecipientResponse[] }>(
    "/api/v1/forward-recipients",
    { signal },
  );
}

export function resendForwardVerification(id: string) {
  return apiRequest<{
    recipient: ForwardRecipientResponse;
    emailSent: boolean;
  }>(`/api/v1/forward-recipients/${id}/resend`, { method: "POST" });
}

export function revokeForwardRecipient(id: string) {
  return apiRequest<ForwardRecipientResponse>(
    `/api/v1/forward-recipients/${id}`,
    { method: "DELETE" },
  );
}

/** Public — used by the /verify-forward page the confirmation email links to. */
export function verifyForwardRecipient(token: string) {
  return apiRequest<{ address: string; organizationName: string }>(
    "/api/v1/forward-recipients/verify",
    { method: "POST", body: { token } },
  );
}
