-- AlterTable
ALTER TABLE "email" ADD COLUMN     "in_reply_to" TEXT,
ADD COLUMN     "references" TEXT,
ADD COLUMN     "thread_headers_captured" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "business_hours" JSONB;

-- CreateTable
CREATE TABLE "tenant_question" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "criteria" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenant_question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_question_tenant_id_status_idx" ON "tenant_question"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_question_tenant_id_key_key" ON "tenant_question"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "email_tenant_id_from_address_received_at_idx" ON "email"("tenant_id", "from_address", "received_at");

-- AddForeignKey
ALTER TABLE "tenant_question" ADD CONSTRAINT "tenant_question_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

