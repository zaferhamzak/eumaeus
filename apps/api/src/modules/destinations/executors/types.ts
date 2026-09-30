/**
 * The DestinationExecutor abstraction. Justified by present need (Phase 5A builds
 * one of the three concrete implementations already scoped in the architecture
 * doc — Archive; Webhook/Email notification follow in 5B/5C reusing this same
 * shape), not speculation.
 *
 * Deliberately narrow: one method, no lifecycle hooks. An executor NEVER throws —
 * every failure mode, including a raw connection error, is caught internally and
 * translated into an ExecutionOutcome. This keeps executeAction.ts's
 * post-execution logic uniform (always inspect a returned outcome, never need to
 * distinguish "thrown vs. returned" at the orchestration layer).
 */
export interface ExecutionContext {
  /** Always populated by executeAction.ts. Required by the webhook executor for secret lookup scoping (manageSecrets.ts); archiveExecutor.ts does not use it. */
  tenantId: string;
  email: {
    id: string;
    mailboxConnectionId: string;
    /** IMAP UID, as stored on Email — see modules/mail-providers/imap's identity strategy. */
    externalId: string;
    uidValidity: number;
    /**
     * Metadata fields added in Phase 5B for the webhook payload (webhookPayload.ts)
     * — archiveExecutor.ts still only reads id/mailboxConnectionId/externalId/
     * uidValidity above and ignores these. Untrusted data (email content), carried
     * as inert values only — see webhookPayload.ts's own doc comment.
     */
    subject: string;
    fromAddress: string;
    toAddresses: string[];
  };
  /** Which RoutingDecision produced this dispatch — used by the webhook payload's `routing` section. */
  routing: {
    destinationRef: string;
  };
  /** The AnalysisResult's answers, when one exists for this RoutingDecision — omitted (not present) when there is none (e.g. status="missing_analysis" is not reachable here, but a future channel type may legitimately have no analysis). */
  analysis?: {
    signals: Record<string, unknown>;
  };
  channel: {
    id: string;
    type: string;
    config: unknown;
    /** Needed by the webhook executor to scope DestinationSecret lookups (a secret is scoped to a Destination, not a channel) — archiveExecutor.ts does not use it. */
    destinationId: string;
  };
  idempotencyKey: string;
}

export type ExecutionOutcome =
  | { status: "succeeded"; responseMetadata?: Record<string, unknown> }
  | { status: "ambiguous"; errorMessage: string; responseMetadata?: Record<string, unknown> }
  | {
      status: "failed";
      /**
       * true  -> executeAction.ts re-throws, letting BullMQ's own attempts/backoff
       *          on the execute-action queue retry the whole job (a NEW pending
       *          row/attempt next time) — e.g. a transient IMAP connection failure.
       * false -> executeAction.ts escalates to Human Review immediately, without
       *          throwing — retrying would not help (e.g. a UIDVALIDITY mismatch:
       *          the stored UID is no longer trustworthy, no amount of retrying
       *          fixes that). Mirrors modules/jev/errors.ts's retryable flag
       *          exactly, applied to destinations.
       */
      retryable: boolean;
      errorClass: string;
      errorMessage: string;
    };

export interface DestinationExecutor {
  readonly channelType: string;
  execute(ctx: ExecutionContext): Promise<ExecutionOutcome>;
}
