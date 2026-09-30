"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dismissAlert, getHostReport, getJevStatus, getMailboxHealth, getQueueHealth, getReport, listAlerts, reprocessEmail, reprocessEmails } from "@/lib/api/ops";
import { simulate } from "@/lib/api/simulations";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";

export function useAlerts(status: "open" | "resolved" = "open") {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["alerts", organizationId, status], queryFn: ({ signal }) => listAlerts(status, signal), refetchInterval: 60_000 });
}

export function useDismissAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => dismissAlert(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useReport(params: { days: 7 | 30 | 90; tz: string; mailboxId?: string }, enabled = true) {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["report", organizationId, params], queryFn: ({ signal }) => getReport(params, signal), enabled });
}

export function useHostReport(params: { days: 7 | 30 | 90; tz: string }, enabled: boolean) {
  return useQuery({ queryKey: ["host-report", params], queryFn: ({ signal }) => getHostReport(params, signal), enabled });
}

/** What reprocessing this email would do right now (read-only). */
export function useReprocessPreview(emailId: string) {
  return useMutation({ mutationFn: () => simulate({ type: "current" }, { emailIds: [emailId] }) });
}

export function useReprocessEmail(emailId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: { reanalyze?: boolean } = {}) => reprocessEmail(emailId, options),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["email"] });
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
}

export function useQueueHealth(enabled: boolean) {
  return useQuery({ queryKey: ["queue-health"], queryFn: ({ signal }) => getQueueHealth(signal), enabled, refetchInterval: 30_000 });
}

export function useMailboxHealth(enabled = true) {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["mailbox-health", organizationId], queryFn: ({ signal }) => getMailboxHealth(signal), enabled, refetchInterval: 60_000 });
}

/** 1.2 (G). */
export function useJevStatus(enabled = true) {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["jev-status", organizationId], queryFn: ({ signal }) => getJevStatus(signal), enabled, refetchInterval: 60_000 });
}

/** Asks Jev again for the emails it couldn't analyze, then routes them with today's rules. */
export function useRetryJev() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (emailIds: string[]) => reprocessEmails(emailIds, { reanalyze: true }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["jev-status"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });
}
