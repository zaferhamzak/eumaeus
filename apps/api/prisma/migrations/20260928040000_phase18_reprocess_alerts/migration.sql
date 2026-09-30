-- DropIndex
DROP INDEX "routing_decision_email_id_key";

-- AlterTable
ALTER TABLE "routing_decision" ADD COLUMN     "superseded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "alert_emails_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alert_webhook_url_encrypted" TEXT;

-- CreateTable
CREATE TABLE "alert" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_notified_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_tenant_id_status_idx" ON "alert"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "alert_tenant_id_kind_subject_key_status_idx" ON "alert"("tenant_id", "kind", "subject_key", "status");

-- CreateIndex
CREATE INDEX "routing_decision_email_id_idx" ON "routing_decision"("email_id");

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 18: at most one CURRENT (not superseded) decision per email. Prisma
-- can't express a partial unique index, so it lives here. A concurrent second
-- evaluation still fails with a unique violation, exactly as before.
CREATE UNIQUE INDEX "routing_decision_current_email_key" ON "routing_decision"("email_id") WHERE "superseded_at" IS NULL;
