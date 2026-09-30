import type { ActionExecution } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { loadEnv } from "../../config/env.js";

/**
 * Deterministic identity for a logical execution: the same
 * (emailId, routingDecisionId, destinationChannelId) triple always produces the
 * same key, computed by any process with zero memory of prior attempts — never
 * random. This key is what groups a sequence of ActionExecution attempt-rows
 * together (phase5-destinations-architecture.md Revision 2 §5) — there is no
 * separate "logical execution" table; the key itself is the grouping identity.
 *
 * Plain deterministic concatenation, not a hash: every component is already a
 * UUID (zero realistic collision risk), and a readable key is easier to inspect
 * in the database than an opaque digest — matching this codebase's general
 * preference for legible identifiers over clever ones.
 */
export function computeIdempotencyKey(emailId: string, routingDecisionId: string, destinationChannelId: string): string {
  return `${emailId}:${routingDecisionId}:${destinationChannelId}`;
}

/**
 * How long a "pending" ActionExecution is trusted to represent a genuinely
 * in-flight attempt before a later caller is allowed to treat it as abandoned
 * (crashed worker) — the same "smallest correct mechanism" pattern as
 * MailboxConnection's sync lock (modules/mail-providers/imap/sync.ts's
 * STALE_LOCK_MS), but NOT copying that constant's value: a mailbox sync and a
 * single destination-execution attempt are answering different questions ("how
 * long can a full IMAP sync take" vs. "how long can ONE attempt on this specific
 * channel take"). The correct basis is each channel type's own per-attempt
 * timeout budget — see getExecutorTimeoutMs below — with a small safety
 * multiple on top, per phase5-destinations-architecture.md Revision 2 §8's
 * explicit reasoning.
 */
const STALE_SAFETY_MULTIPLIER = 3;

/**
 * Archive's own per-attempt timeout. A single IMAP MOVE (after an already-open
 * connection) is expected to complete in low single-digit seconds even against a
 * slow server; 15s is deliberately generous headroom, mirroring how
 * modules/jev/client.ts's PER_ATTEMPT_TIMEOUT_MS (10s) was chosen relative to
 * Jev's documented 70-500ms typical latency. Exported so archiveExecutor.ts uses
 * the SAME number this staleness calculation is derived from — one source of
 * truth, not two constants that could drift apart.
 */
export const ARCHIVE_EXECUTOR_TIMEOUT_MS = 15_000;

/**
 * Phase 13: one whole SMTP transaction for a forward (connect, TLS, auth,
 * upload of up to a 25 MB message). forwardExecutor.ts uses this same number
 * as its own send timeout.
 */
export const FORWARD_EXECUTOR_TIMEOUT_MS = 60_000;

/**
 * Per-channel-type timeout lookup — written as a lookup rather than a single
 * constant so a future channel type's own timeout doesn't require touching this
 * function's shape, only adding an entry. Phase 5A added "archive"; Phase 5B adds
 * "webhook" (its per-attempt HTTP timeout, WEBHOOK_TIMEOUT_MS — the SAME number
 * webhookExecutor.ts uses for its own request timeout, one source of truth).
 */
function getExecutorTimeoutMs(channelType: string): number {
  // A flag STORE is one IMAP round-trip like a move; same budget.
  if (channelType === "archive" || channelType === "flag") return ARCHIVE_EXECUTOR_TIMEOUT_MS;
  if (channelType === "forward" || channelType === "auto_reply" || channelType === "email_notify") return FORWARD_EXECUTOR_TIMEOUT_MS;
  // Phase 19 integrations go through the webhook HTTP client and its timeout.
  if (channelType === "slack" || channelType === "teams" || channelType === "jira" || channelType === "zendesk") return loadEnv().WEBHOOK_TIMEOUT_MS;
  if (channelType === "webhook") return loadEnv().WEBHOOK_TIMEOUT_MS;
  // Unreachable given manageDestinations.ts's save-time validation — a
  // defensive, honest failure rather than silently guessing a number for a
  // channel type this function doesn't know about.
  throw new Error(`No known timeout for channel type "${channelType}" — cannot compute a staleness threshold`);
}

export type IdempotencyDecision =
  | { action: "proceed" }
  | { action: "skip_succeeded"; existing: ActionExecution }
  | { action: "skip_in_progress"; existing: ActionExecution }
  | { action: "skip_ambiguous"; existing: ActionExecution }
  | { action: "skip_permanently_failed"; existing: ActionExecution }
  | { action: "stale_pending"; existing: ActionExecution };

/**
 * The DB-level idempotency check (phase5-destinations-architecture.md Revision 2
 * §6's "layer 2" — the one Eumaeus actually controls and treats as authoritative).
 * Looks at the MOST RECENT ActionExecution row for this key, if any, and decides
 * what the caller (executeAction.ts) should do next. This function only reads —
 * it never creates or mutates a row itself; see executeAction.ts for where the
 * pending row is actually written (with real DB-level race protection, not just
 * this check) and where a stale row is actually finalized.
 */
export async function checkIdempotency(idempotencyKey: string, channelType: string): Promise<IdempotencyDecision> {
  const latest = await prisma.actionExecution.findFirst({
    where: { idempotencyKey },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) return { action: "proceed" };

  if (latest.status === "succeeded") return { action: "skip_succeeded", existing: latest };

  if (latest.status === "ambiguous") return { action: "skip_ambiguous", existing: latest };

  if (latest.status === "failed") {
    if (!latest.retryable) {
      // A prior attempt failed PERMANENTLY (retryable: false) and was already
      // escalated to Human Review at the time it happened
      // (executeAction.ts's outcome.retryable === false branch). No amount of
      // retrying fixes a permanent error (e.g. UIDVALIDITY mismatch) — this
      // must never be auto-retried, for exactly the same reason "ambiguous"
      // never is. Without this check, a re-dispatch for the same
      // idempotencyKey (e.g. a retried process-email job re-running
      // dispatchRoutingDecision) would silently attempt the destination action
      // again from scratch instead of recognizing the permanent failure
      // already on record (audit finding: Phase 5A audit, idempotency §6).
      return { action: "skip_permanently_failed", existing: latest };
    }
    // A prior attempt failed with a RETRYABLE error. Whether THIS invocation
    // should try again is not re-decided here — it already was, at the queue
    // level: BullMQ's own attempts/backoff on the execute-action queue is what
    // determines whether this function even gets called again for the same
    // key. If we're being asked, a new attempt is allowed; the ceiling on how
    // many times that can happen is BullMQ's configured `attempts`, not a
    // second, independent retry counter here — avoiding exactly the "kendi
    // başına sınırsız retry sistemi" this phase was told not to build.
    return { action: "proceed" };
  }

  // latest.status === "pending"
  const ageMs = Date.now() - latest.startedAt.getTime();
  const staleThresholdMs = getExecutorTimeoutMs(channelType) * STALE_SAFETY_MULTIPLIER;
  if (ageMs < staleThresholdMs) {
    return { action: "skip_in_progress", existing: latest };
  }
  return { action: "stale_pending", existing: latest };
}
