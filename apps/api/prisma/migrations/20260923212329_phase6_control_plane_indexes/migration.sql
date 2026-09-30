-- AlterTable
ALTER TABLE "human_review_item" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "action_execution_tenant_id_created_at_idx" ON "action_execution"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_created_at_idx" ON "audit_event"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "email_tenant_id_received_at_idx" ON "email"("tenant_id", "received_at");

-- CreateIndex
CREATE INDEX "human_review_item_tenant_id_status_created_at_idx" ON "human_review_item"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "routing_decision_tenant_id_created_at_idx" ON "routing_decision"("tenant_id", "created_at");
