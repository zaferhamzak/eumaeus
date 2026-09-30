import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { executeAction, type ExecuteActionInput } from "../../src/modules/destinations/executeAction.js";
import { dispatchRoutingDecision } from "../../src/modules/destinations/dispatchRoutingDecision.js";
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";
import { createWebhookExecutor } from "../../src/modules/destinations/executors/webhookExecutor.js";
import { finalizeExhaustedAction } from "../../src/queue/workers/executeAction.worker.js";
import type { DestinationExecutor, ExecutionOutcome } from "../../src/modules/destinations/executors/types.js";
import {
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  createWebhookDestination,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";

const fakeDns = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

async function setup() {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
  const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
  const { destination, channel } = await createWebhookDestination(tenant.id, "webhook-dest", "https://hooks.example.com/incoming");
  const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
  const idempotencyKey = computeIdempotencyKey(email.id, routingDecision.id, channel.id);
  return { tenant, email, destination, channel, routingDecision, idempotencyKey };
}

function withWebhookExecutor(performRequest: () => Promise<{ statusCode: number }>): Record<string, DestinationExecutor> {
  return { webhook: createWebhookExecutor({ dnsLookup: fakeDns, performRequest }) };
}

describe("webhook channel — ActionExecution/idempotency integration (reuses the SAME machinery archive uses)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("end-to-end: RoutingDecision -> dispatchRoutingDecision -> executeAction -> ActionExecution -> webhookExecutor -> successful webhook", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();

    // dispatchRoutingDecision resolves the destination and enqueues the real
    // execute-action BullMQ job — proving the RoutingDecision -> dispatch ->
    // queue leg of the chain for the webhook channel specifically (the generic
    // enqueue mechanics themselves are already covered channel-agnostically in
    // actionExecution.test.ts).
    await dispatchRoutingDecision(routingDecision);
    const { getExecuteActionQueue } = await import("../../src/queue/executeActionQueue.js");
    const job = await getExecuteActionQueue().getJob(idempotencyKey);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({ emailId: email.id, destinationChannelId: channel.id, idempotencyKey });
    await job?.remove(); // this test drives executeAction directly below (with a fake HTTP transport) rather than running a real worker

    let callCount = 0;
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };
    await executeAction(
      input,
      withWebhookExecutor(async () => {
        callCount += 1;
        return { statusCode: 200 };
      }),
    );

    expect(callCount).toBe(1);
    const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
    expect(execution).toMatchObject({ status: "succeeded", channelType: "webhook" });

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems).toHaveLength(0);
  });

  it("a permanent webhook failure (404) reaches the 'failed' terminal state and escalates to Human Review", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

    await executeAction(input, withWebhookExecutor(async () => ({ statusCode: 404 })));

    const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
    expect(execution).toMatchObject({ status: "failed", retryable: false, channelType: "webhook" });

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems[0]).toMatchObject({ reason: "execution_failed" });
  });

  it("duplicate invocation of an already-succeeded webhook execution is a no-op — the HTTP call is not repeated", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();
    let callCount = 0;
    const executors = withWebhookExecutor(async () => {
      callCount += 1;
      return { statusCode: 200 };
    });
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

    await executeAction(input, executors);
    await executeAction(input, executors);

    expect(callCount).toBe(1);
  });

  it("concurrent invocation cannot create two logical webhook executions", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();
    let callCount = 0;
    const executors: Record<string, DestinationExecutor> = {
      webhook: createWebhookExecutor({
        dnsLookup: fakeDns,
        performRequest: async () => {
          callCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { statusCode: 200 };
        },
      }),
    };
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

    await Promise.all([executeAction(input, executors), executeAction(input, executors)]);

    expect(callCount).toBe(1);
    const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey } });
    expect(executions).toHaveLength(1);
  });

  it("the same idempotencyKey is reused across a retryable-failure-then-success attempt sequence", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();
    const responses = [{ statusCode: 503 }, { statusCode: 200 }];
    let call = 0;
    const executors = withWebhookExecutor(async () => responses[call++] as { statusCode: number });
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

    await expect(executeAction(input, executors)).rejects.toThrow();
    await executeAction(input, executors);

    const executions = await prisma.actionExecution.findMany({ where: { idempotencyKey }, orderBy: { attemptNumber: "asc" } });
    expect(executions.every((e) => e.idempotencyKey === idempotencyKey)).toBe(true);
    expect(executions.map((e) => e.status)).toEqual(["failed", "succeeded"]);
  });

  it("a late webhook result cannot overwrite a row already finalized ambiguous by a racing finalizer — the Phase 5A terminal-state protection also covers the webhook channel", async () => {
    const { email, channel, routingDecision, idempotencyKey } = await setup();

    let releaseExecutor!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const slowSucceedingExecutor: DestinationExecutor = {
      channelType: "webhook",
      async execute(): Promise<ExecutionOutcome> {
        await gate;
        return { status: "succeeded" };
      },
    };
    const input: ExecuteActionInput = { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey };

    const executePromise = executeAction(input, { webhook: slowSucceedingExecutor });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await finalizeExhaustedAction(idempotencyKey, "simulated worker crash", 1);
    releaseExecutor();
    await executePromise;

    const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
    expect(execution.status).toBe("ambiguous"); // NOT overwritten to "succeeded"

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems).toHaveLength(1); // not duplicated
  });
});
