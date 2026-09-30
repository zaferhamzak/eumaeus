-- CreateTable
CREATE TABLE "destination" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_channel" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destination_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_execution" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "routing_decision_id" TEXT NOT NULL,
    "destination_channel_id" TEXT NOT NULL,
    "channel_type" TEXT NOT NULL,
    "channel_version" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "retryable" BOOLEAN,
    "error_class" TEXT,
    "error_message" TEXT,
    "request_metadata" JSONB,
    "response_metadata" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "destination_tenant_id_name_key" ON "destination"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "destination_channel_tenant_id_destination_id_enabled_idx" ON "destination_channel"("tenant_id", "destination_id", "enabled");

-- CreateIndex
CREATE INDEX "action_execution_idempotency_key_idx" ON "action_execution"("idempotency_key");

-- CreateIndex
CREATE INDEX "action_execution_email_id_idx" ON "action_execution"("email_id");

-- AddForeignKey
ALTER TABLE "destination" ADD CONSTRAINT "destination_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_channel" ADD CONSTRAINT "destination_channel_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_channel" ADD CONSTRAINT "destination_channel_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_execution" ADD CONSTRAINT "action_execution_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_execution" ADD CONSTRAINT "action_execution_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_execution" ADD CONSTRAINT "action_execution_routing_decision_id_fkey" FOREIGN KEY ("routing_decision_id") REFERENCES "routing_decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_execution" ADD CONSTRAINT "action_execution_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "destination_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Manually added (not representable in schema.prisma's @@unique/@@index syntax, which
-- has no partial/conditional-index support): a PARTIAL unique index that only applies
-- WHERE status = 'pending'. This is the real, database-enforced concurrency
-- protection for ActionExecution (see implementation-plan.md §Y's documented
-- convention of augmenting a generated migration with raw SQL for things Prisma's
-- schema language can't express, e.g. RLS policies).
--
-- Effect: two concurrent callers racing to create a "pending" row for the same
-- idempotencyKey cannot both succeed — Postgres itself rejects the second INSERT
-- with a unique_violation (23505 / Prisma P2002), which
-- modules/destinations/executeAction.ts catches and treats as "another attempt
-- already won the race, skip." Once a row's status moves to succeeded/failed/
-- ambiguous, the index no longer applies to it, so a LATER, legitimate new attempt
-- (a fresh pending row for the same idempotencyKey) is not blocked by history.
CREATE UNIQUE INDEX "action_execution_pending_idempotency_key_key"
  ON "action_execution" ("idempotency_key")
  WHERE "status" = 'pending';
