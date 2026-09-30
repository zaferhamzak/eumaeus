import { prisma } from "../../db/client.js";
import { monitoredAddresses } from "./manageDestinations.js";
import type { ForwardChannelConfig } from "./types.js";

/**
 * The send-time guardrails shared by immediate forwards (forwardExecutor.ts)
 * and digests (forwardDigest.ts). Settings can change after a channel was
 * saved, so these are always evaluated at the moment of sending.
 */
export type SkipReason = "unverified" | "domain_not_allowed" | "monitored_mailbox";

export interface DeliverableRecipients {
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  skipped: Array<{ address: string; reason: SkipReason }>;
  count: number;
}

export async function resolveDeliverableRecipients(tenantId: string, config: ForwardChannelConfig): Promise<DeliverableRecipients> {
  const requested = { to: config.to, cc: config.cc ?? [], bcc: config.bcc ?? [] };
  const all = [...requested.to, ...requested.cc, ...requested.bcc];
  const [tenant, verifiedRows, monitored] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { forwardAllowedDomains: true } }),
    prisma.forwardRecipient.findMany({ where: { tenantId, address: { in: all }, status: "verified" }, select: { address: true } }),
    monitoredAddresses(tenantId),
  ]);
  const verified = new Set(verifiedRows.map((r) => r.address));
  const allowedDomains = tenant.forwardAllowedDomains.map((d) => d.toLowerCase());

  const skipped: DeliverableRecipients["skipped"] = [];
  const keep = (address: string): boolean => {
    let reason: SkipReason | undefined;
    if (monitored.has(address)) reason = "monitored_mailbox";
    else if (allowedDomains.length > 0 && !allowedDomains.includes(address.split("@")[1] ?? "")) reason = "domain_not_allowed";
    else if (!verified.has(address)) reason = "unverified";
    if (reason) skipped.push({ address, reason });
    return reason === undefined;
  };
  const recipients = { to: requested.to.filter(keep), cc: requested.cc.filter(keep), bcc: requested.bcc.filter(keep) };
  return { recipients, skipped, count: recipients.to.length + recipients.cc.length + recipients.bcc.length };
}

export function describeSkipped(skipped: DeliverableRecipients["skipped"]): string {
  return skipped.map((s) => `${s.address} (${s.reason})`).join(", ");
}

/**
 * Forward messages actually sent in the last 24h: immediate forwards plus
 * digest messages (one digest = one message). Queuing an email into a digest
 * is recorded as a succeeded execution too, so those are subtracted.
 */
export async function forwardsSentLast24h(tenantId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const succeeded = { tenantId, channelType: "forward", status: "succeeded", completedAt: { gte: since } };
  const [allSucceeded, queuedIntoDigest, digestsSent, autoReplies, notices] = await Promise.all([
    prisma.actionExecution.count({ where: succeeded }),
    prisma.actionExecution.count({ where: { ...succeeded, responseMetadata: { path: ["delivery"], equals: "digest" } } }),
    prisma.forwardDigestBatch.count({ where: { tenantId, status: "sent", completedAt: { gte: since } } }),
    // Phase 19: auto-replies share the same outgoing-mail budget (skipped ones don't count).
    prisma.actionExecution.count({ where: { tenantId, channelType: "auto_reply", status: "succeeded", completedAt: { gte: since }, responseMetadata: { path: ["sent"], equals: true } } }),
    // 1.2 (O): rule notifications too — counted from the delivery log, one per message sent.
    prisma.outboundEmail.count({ where: { tenantId, kind: "rule_notify", status: "sent", createdAt: { gte: since } } }),
  ]);
  return allSucceeded - queuedIntoDigest + digestsSent + autoReplies + notices;
}

/** null when under the limit, otherwise the refusal message. */
export async function checkDailyLimit(tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { forwardDailyLimit: true } });
  if ((await forwardsSentLast24h(tenantId)) >= tenant.forwardDailyLimit) {
    return `This organization's forwarding limit (${tenant.forwardDailyLimit} per 24 hours) has been reached`;
  }
  return null;
}
