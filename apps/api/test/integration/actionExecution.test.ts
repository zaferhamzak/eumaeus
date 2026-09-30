import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { executeAction } from "../../src/modules/destinations/executeAction.js";
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";
import { dispatchRoutingDecision } from "../../src/modules/destinations/dispatchRoutingDecision.js";
import { updateDestinationChannel } from "../../src/modules/destinations/manageDestinations.js";
import { RESERVED_HUMAN_REVIEW_DESTINATION_REF } from "../../src/modules/destinations/types.js";
import { finalizeExhaustedAction } from "../../src/queue/workers/executeAction.worker.js";
import { createFakeExecutor, executorThatMustNotBeCalled } from "../fixtures/fakeExecutor.js";
import type { DestinationExecutor, ExecutionOutcome } from "../../src/modules/destinations/executors/types.js";
import {
  createArchiveDestination,
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";

async function setup(externalId = "1") {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, externalId);
  const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
  const { destination, channel } = await createArchiveDestination(tenant.id, "archive-dest");
  const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
  const idempotencyKey = computeIdempotencyKey(email.id, routingDecision.id, channel.id);
  return { tenant, email, destination, channel, routingDecision, idempotencyKey };
}

function withExecutor(executor: ReturnType<typeof createFakeExecutor> | ReturnType<typeof executorThatMustNotBeCalled>) {
  return { archive: executor };
}

describe("executeAction — idempotency, concurrency, failure classification, provenance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe("idempotency", () => {
    it("an existing succeeded execution makes a second invocation a no-op — the executor is not called again", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      const executor = createFakeExecutor([{ status: "succeeded" }]);
      await executeAction(input, withExecutor(executor));
      await executeAction(input, withExecutor(executorThatMustNotBeCalled()));

      expect(executor.callCount).toBe(1);
      const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey } });
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("succeeded");
    });

    it("a recent pending execution is skipped, not re-attempted", async () => {
      const { tenant, email, routingDecision, channel, idempotencyKey } = await setup();
      await prisma.actionExecution.create({
        data: {
          tenantId: tenant.id,
          emailId: email.id,
          routingDecisionId: routingDecision.id,
          destinationChannelId: channel.id,
          channelType: "archive",
          channelVersion: 1,
          idempotencyKey,
          attemptNumber: 1,
          status: "pending",
        },
      });

      await executeAction(
        { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
        withExecutor(executorThatMustNotBeCalled()),
      );

      const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey } });
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("pending");
    });

    it("a stale pending execution is finalized ambiguous and escalated, without re-attempting", async () => {
      const { tenant, email, routingDecision, channel, idempotencyKey } = await setup();
      const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago — well past any staleness threshold
      await prisma.actionExecution.create({
        data: {
          tenantId: tenant.id,
          emailId: email.id,
          routingDecisionId: routingDecision.id,
          destinationChannelId: channel.id,
          channelType: "archive",
          channelVersion: 1,
          idempotencyKey,
          attemptNumber: 1,
          status: "pending",
          startedAt: longAgo,
        },
      });

      await executeAction(
        { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
        withExecutor(executorThatMustNotBeCalled()),
      );

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution.status).toBe("ambiguous");

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1);
      expect(reviewItems[0]).toMatchObject({ reason: "execution_ambiguous", status: "open" });
    });

    it("an existing ambiguous execution is not retried, and escalating twice does not duplicate the HumanReviewItem", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      const executor = createFakeExecutor([{ status: "ambiguous", errorMessage: "connection dropped mid-move" }]);
      await executeAction(input, withExecutor(executor));
      await executeAction(input, withExecutor(executorThatMustNotBeCalled())); // second call must not re-attempt

      expect(executor.callCount).toBe(1);
      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1); // not duplicated by the second call's own escalation attempt
    });

    it("a prior failed attempt allows a new attempt (bounded by BullMQ's own attempts, not a second retry counter)", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      const executor = createFakeExecutor([
        { status: "failed", retryable: true, errorClass: "connection", errorMessage: "ETIMEDOUT" },
        { status: "succeeded" },
      ]);
      await expect(executeAction(input, withExecutor(executor))).rejects.toThrow(/ETIMEDOUT/);
      await executeAction(input, withExecutor(executor));

      expect(executor.callCount).toBe(2);
      const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey }, orderBy: { attemptNumber: "asc" } });
      expect(executions.map((e) => [e.attemptNumber, e.status])).toEqual([
        [1, "failed"],
        [2, "succeeded"],
      ]);
    });

    it("a permanently-failed (non-retryable) execution is not re-attempted on a re-dispatch — treated like ambiguous, never auto-retried", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      const executor = createFakeExecutor([{ status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: "UIDVALIDITY mismatch" }]);
      await executeAction(input, withExecutor(executor));
      expect(executor.callCount).toBe(1);

      // Simulate a re-dispatch for the exact same idempotencyKey (e.g. a retried
      // process-email job re-running dispatchRoutingDecision) — must not attempt
      // the destination action again from scratch, since the prior failure was
      // permanent and was already escalated.
      await executeAction(input, withExecutor(executorThatMustNotBeCalled()));

      const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey } });
      expect(executions).toHaveLength(1); // no new attempt row created
      expect(executions[0]?.status).toBe("failed");

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1); // not duplicated by the second call's own escalation attempt
    });
  });

  describe("concurrency", () => {
    it("two callers starting with the same idempotencyKey at the same time do not create a duplicate logical execution", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      // A shared executor with an artificial delay widens the race window enough
      // that both callers reliably pass their idempotency check before either
      // one's pending-row INSERT lands — mirroring the exact technique used for
      // MailboxConnection's own concurrency test.
      const executor = createFakeExecutor([{ status: "succeeded" }], 40);

      await Promise.all([executeAction(input, withExecutor(executor)), executeAction(input, withExecutor(executor))]);

      // The DB-level partial unique index is what actually decides the winner —
      // not application logic — so the executor may be invoked by whichever
      // caller's INSERT lands first, but never by both.
      expect(executor.callCount).toBe(1);
      const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey } });
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("succeeded");
    });

    it("two callers racing to finalize the same stale-pending row produce exactly one ambiguous transition and one escalation", async () => {
      const { tenant, email, routingDecision, channel, idempotencyKey } = await setup();
      const longAgo = new Date(Date.now() - 60 * 60 * 1000); // well past any staleness threshold
      await prisma.actionExecution.create({
        data: {
          tenantId: tenant.id,
          emailId: email.id,
          routingDecisionId: routingDecision.id,
          destinationChannelId: channel.id,
          channelType: "archive",
          channelVersion: 1,
          idempotencyKey,
          attemptNumber: 1,
          status: "pending",
          startedAt: longAgo,
        },
      });

      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };
      // Both calls independently discover the same stale row and race to
      // finalize it via executeAction.ts's own conditional
      // updateMany({ where: { id, status: "pending" } }) — the DB, not
      // application logic, decides the winner.
      await Promise.all([
        executeAction(input, withExecutor(executorThatMustNotBeCalled())),
        executeAction(input, withExecutor(executorThatMustNotBeCalled())),
      ]);

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution.status).toBe("ambiguous");

      const ambiguousAudits = await prisma.auditEvent.findMany({ where: { emailId: email.id, eventType: "action_execution_ambiguous" } });
      expect(ambiguousAudits).toHaveLength(1); // only the race's winner logs the audit event

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1); // the loser's own unconditional escalateToHumanReview call is a no-op (open item already exists)
    });
  });

  describe("terminal state protection (Phase 5A audit fix — late executor results must not overwrite an already-finalized row)", () => {
    it("a slow executor's success must not overwrite a row already finalized ambiguous by a racing finalizer", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      let releaseExecutor!: () => void;
      const executorGate = new Promise<void>((resolve) => {
        releaseExecutor = resolve;
      });
      const slowSucceedingExecutor: DestinationExecutor = {
        channelType: "archive",
        async execute(): Promise<ExecutionOutcome> {
          await executorGate;
          return { status: "succeeded" };
        },
      };

      const executePromise = executeAction(input, withExecutor(slowSucceedingExecutor));

      // Let executeAction create the pending row and call the (still-blocked) executor.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const midFlight = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(midFlight.status).toBe("pending");

      // A second actor — in production, the worker.on("failed") backstop once
      // BullMQ's attempts are exhausted — finalizes this SAME execution
      // ambiguous WHILE the original attempt above is still genuinely in
      // flight. This is the exact race the Phase 5A audit flagged.
      await finalizeExhaustedAction(idempotencyKey, "simulated worker crash", 1);

      const afterFinalize = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(afterFinalize.status).toBe("ambiguous");

      // Now the original, still in-flight attempt finally resolves with success.
      releaseExecutor();
      await executePromise;

      const finalExecution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(finalExecution.status).toBe("ambiguous"); // must NOT have been overwritten to "succeeded"

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1);
      expect(reviewItems[0]).toMatchObject({ reason: "execution_ambiguous" });

      const ambiguousAudits = await prisma.auditEvent.findMany({ where: { emailId: email.id, eventType: "action_execution_ambiguous" } });
      expect(ambiguousAudits).toHaveLength(1); // exactly one — the late "succeeded" outcome must not add another

      const succeededAudits = await prisma.auditEvent.findMany({ where: { emailId: email.id, eventType: "action_execution_succeeded" } });
      expect(succeededAudits).toHaveLength(0); // the late outcome must never be recorded as a success
    });

    it("a slow executor's permanent failure must not overwrite a row already finalized ambiguous by a racing finalizer", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const input = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

      let releaseExecutor!: () => void;
      const executorGate = new Promise<void>((resolve) => {
        releaseExecutor = resolve;
      });
      const slowFailingExecutor: DestinationExecutor = {
        channelType: "archive",
        async execute(): Promise<ExecutionOutcome> {
          await executorGate;
          return { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: "late permanent failure" };
        },
      };

      const executePromise = executeAction(input, withExecutor(slowFailingExecutor));
      await new Promise((resolve) => setTimeout(resolve, 20));

      await finalizeExhaustedAction(idempotencyKey, "simulated worker crash", 1);
      releaseExecutor();
      await executePromise;

      const finalExecution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(finalExecution.status).toBe("ambiguous"); // must NOT have been overwritten to "failed"

      const failedAudits = await prisma.auditEvent.findMany({ where: { emailId: email.id, eventType: "action_execution_failed" } });
      expect(failedAudits).toHaveLength(0);

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1); // the discarded late failure must not add a second, contradictory escalation
    });
  });

  describe("failure classification", () => {
    it("a permanent failure (retryable=false) is recorded and escalated immediately, without throwing", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const executor = createFakeExecutor([{ status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: "UIDVALIDITY mismatch" }]);

      await expect(
        executeAction(
          { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
          withExecutor(executor),
        ),
      ).resolves.toBeUndefined();

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution).toMatchObject({ status: "failed", retryable: false, errorClass: "invalid_config" });

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems[0]).toMatchObject({ reason: "execution_failed" });
    });

    it("a retryable failure is recorded and re-thrown, letting the caller (BullMQ) retry", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const executor = createFakeExecutor([{ status: "failed", retryable: true, errorClass: "connection", errorMessage: "ECONNREFUSED" }]);

      await expect(
        executeAction(
          { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
          withExecutor(executor),
        ),
      ).rejects.toThrow(/ECONNREFUSED/);

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution).toMatchObject({ status: "failed", retryable: true });
      // Not escalated yet — a retryable failure only escalates once BullMQ's own
      // attempts are exhausted (queue/workers/executeAction.worker.ts's backstop).
      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(0);
    });
  });

  describe("provenance", () => {
    it("records the correct destinationChannelId, channelType, channelVersion, and idempotencyKey", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const executor = createFakeExecutor([{ status: "succeeded" }]);
      await executeAction(
        { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
        withExecutor(executor),
      );

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution).toMatchObject({
        destinationChannelId: channel.id,
        channelType: "archive",
        channelVersion: 1,
        idempotencyKey,
        attemptNumber: 1,
      });
    });

    it("a channel config edit after execution does not alter the already-recorded execution's provenance", async () => {
      const { email, routingDecision, channel, idempotencyKey } = await setup();
      const executor = createFakeExecutor([{ status: "succeeded" }]);
      await executeAction(
        { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey },
        withExecutor(executor),
      );

      await updateDestinationChannel(channel.id, { type: "archive", config: { folder: "SomewhereElse" } });

      const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
      expect(execution.destinationChannelId).toBe(channel.id); // still points at v1's row
      expect(execution.channelVersion).toBe(1); // unaffected by the edit that created v2
    });
  });

  describe("Human Review reserved target (not a DestinationChannel)", () => {
    it("dispatching a routingDecision with destinationRef='human_review' escalates directly, with no ActionExecution created", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, RESERVED_HUMAN_REVIEW_DESTINATION_REF);

      await dispatchRoutingDecision(routingDecision);

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1);
      expect(reviewItems[0]).toMatchObject({ reason: "manual_review_requested" });
      const executions = await prisma.actionExecution.findMany({ where: { emailId: email.id } });
      expect(executions).toHaveLength(0);
    });

    it("dispatching twice does not create a duplicate HumanReviewItem", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, RESERVED_HUMAN_REVIEW_DESTINATION_REF);

      await dispatchRoutingDecision(routingDecision);
      await dispatchRoutingDecision(routingDecision);

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(1);
    });
  });

  describe("dispatchRoutingDecision — the happy path that actually enqueues a job", () => {
    it("a successfully-resolved destination enqueues one execute-action job per enabled channel, with the correct idempotencyKey as jobId", async () => {
      const { email, destination, channel, routingDecision, idempotencyKey } = await setup();
      // sanity: setup()'s routingDecision.destinationRef already points at `destination.name`
      expect(routingDecision.destinationRef).toBe(destination.name);

      await dispatchRoutingDecision(routingDecision);

      const { getExecuteActionQueue } = await import("../../src/queue/executeActionQueue.js");
      const job = await getExecuteActionQueue().getJob(idempotencyKey);
      expect(job).toBeDefined();
      expect(job?.data).toMatchObject({
        emailId: email.id,
        routingDecisionId: routingDecision.id,
        destinationChannelId: channel.id,
        idempotencyKey,
      });

      // No escalation on the happy path — resolution succeeded, a job was queued,
      // nothing has failed yet.
      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toHaveLength(0);

      await job?.remove();
    });
  });

  describe("destination resolution failure", () => {
    it("a destinationRef that resolves to nothing escalates, with no ActionExecution created", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, "does-not-exist");

      await dispatchRoutingDecision(routingDecision);

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems[0]).toMatchObject({ reason: "execution_failed" });
      const auditEvents = await prisma.auditEvent.findMany({ where: { emailId: email.id, eventType: "destination_resolution_failed" } });
      expect(auditEvents).toHaveLength(1);
    });
  });
});
