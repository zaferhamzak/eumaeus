import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/client.js";
import { loadEnv } from "../../config/env.js";
import { resolveReviewItem, type ReviewResolution } from "./resolveReview.js";

/**
 * Phase 23: one-click decisions from the Human Review digest email. Each link
 * carries { organization, review item, decision, recipient, expiry } signed
 * with an HMAC key derived from SECRET_ENCRYPTION_KEY (a separate key per
 * purpose — never the encryption key itself). No table: the item being
 * resolved is what makes a link single-use, and the expiry bounds how long a
 * forwarded digest stays useful.
 *
 * Clicking opens a confirmation page (a mail scanner prefetching links must
 * not decide anything); confirming re-checks that the recipient is still an
 * active member allowed to resolve reviews in that organization, and records
 * them as the actor.
 */
export const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ActionPayload {
  t: string; // tenant id
  i: string; // review item id
  r: ReviewResolution;
  u: string; // recipient user id
  e: number; // expiry (ms)
}

// Key-derivation label. Links signed under the product's former name keep
// working until they expire (7 days after the rename).
const KEY_LABEL = "eumaeus:review-action:v1";
const LEGACY_KEY_LABEL = "jevmail:review-action:v1";

function key(label = KEY_LABEL): Buffer {
  return createHmac("sha256", Buffer.from(loadEnv().SECRET_ENCRYPTION_KEY, "base64")).update(label).digest();
}

function sign(body: string, label = KEY_LABEL): string {
  return createHmac("sha256", key(label)).update(body).digest("base64url");
}

function macMatches(body: string, mac: string, label: string): boolean {
  const expected = Buffer.from(sign(body, label));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function createReviewActionToken(input: { tenantId: string; itemId: string; resolution: ReviewResolution; userId: string }, now: Date = new Date()): string {
  const body = Buffer.from(JSON.stringify({ t: input.tenantId, i: input.itemId, r: input.resolution, u: input.userId, e: now.getTime() + ACTION_TTL_MS } satisfies ActionPayload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export class ReviewActionError extends Error {
  constructor(
    public readonly code: "invalid" | "expired" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

export function verifyReviewActionToken(token: string, now: Date = new Date()): ActionPayload {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new ReviewActionError("invalid", "This link is not valid.");
  if (!macMatches(body, mac, KEY_LABEL) && !macMatches(body, mac, LEGACY_KEY_LABEL)) throw new ReviewActionError("invalid", "This link is not valid.");
  let payload: ActionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ActionPayload;
  } catch {
    throw new ReviewActionError("invalid", "This link is not valid.");
  }
  if (payload.r !== "spam" && payload.r !== "approved") throw new ReviewActionError("invalid", "This link is not valid.");
  if (payload.e <= now.getTime()) throw new ReviewActionError("expired", "This link has expired. Open Human Review in Eumaeus to decide.");
  return payload;
}

export interface ReviewActionPreview {
  organizationName: string;
  resolution: ReviewResolution;
  subject: string | null;
  fromAddress: string;
  /** Already decided (by anyone, or closed by reprocessing): confirming does nothing. */
  alreadyClosed: boolean;
  status: string;
}

async function load(payload: ActionPayload) {
  const item = await prisma.humanReviewItem.findFirst({
    where: { id: payload.i, tenantId: payload.t },
    include: { email: { select: { subject: true, fromAddress: true } }, tenant: { select: { name: true } } },
  });
  if (!item) throw new ReviewActionError("invalid", "This review item no longer exists.");
  return item;
}

export async function previewReviewAction(token: string): Promise<ReviewActionPreview> {
  const payload = verifyReviewActionToken(token);
  const item = await load(payload);
  return { organizationName: item.tenant.name, resolution: payload.r, subject: item.email.subject, fromAddress: item.email.fromAddress, alreadyClosed: item.status !== "open", status: item.status };
}

export async function confirmReviewAction(token: string): Promise<ReviewActionPreview & { resolved: boolean }> {
  const payload = verifyReviewActionToken(token);
  const item = await load(payload);
  const user = await prisma.user.findUnique({ where: { id: payload.u }, include: { memberships: { where: { tenantId: payload.t, status: "active" } } } });
  const allowed = user?.status === "active" && (user.isSuperAdmin || user.memberships.some((m) => m.permissions.includes("reviews:resolve")));
  if (!user || !allowed) throw new ReviewActionError("forbidden", "You can no longer decide review items in this organization.");
  const before = item.status;
  const after = await resolveReviewItem(payload.t, payload.i, payload.r, user.email);
  return {
    organizationName: item.tenant.name,
    resolution: payload.r,
    subject: item.email.subject,
    fromAddress: item.email.fromAddress,
    alreadyClosed: before !== "open",
    status: after?.status ?? before,
    resolved: before === "open" && after?.status === "resolved",
  };
}
