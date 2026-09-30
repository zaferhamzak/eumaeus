-- CreateTable
CREATE TABLE "rule" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "destination_ref" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_evaluation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "reason" JSONB NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_decision" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "matched_rule_id" TEXT,
    "matched_rule_version" INTEGER,
    "destination_ref" TEXT,
    "analysis_result_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_tenant_id_enabled_priority_idx" ON "rule"("tenant_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "rule_evaluation_email_id_idx" ON "rule_evaluation"("email_id");

-- CreateIndex
CREATE UNIQUE INDEX "routing_decision_email_id_key" ON "routing_decision"("email_id");

-- AddForeignKey
ALTER TABLE "rule" ADD CONSTRAINT "rule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_evaluation" ADD CONSTRAINT "rule_evaluation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_evaluation" ADD CONSTRAINT "rule_evaluation_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_evaluation" ADD CONSTRAINT "rule_evaluation_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_decision" ADD CONSTRAINT "routing_decision_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_decision" ADD CONSTRAINT "routing_decision_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_decision" ADD CONSTRAINT "routing_decision_matched_rule_id_fkey" FOREIGN KEY ("matched_rule_id") REFERENCES "rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
