-- AlterTable
ALTER TABLE "routing_decision" ADD COLUMN     "sender_list_entry_id" TEXT,
ADD COLUMN     "sender_list_pattern" TEXT;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "block_destination_ref" TEXT;

-- CreateTable
CREATE TABLE "sender_list_entry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_list_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_suggestion" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "resolved_count" INTEGER NOT NULL,
    "spam_count" INTEGER NOT NULL,
    "approved_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_list_entry_tenant_id_pattern_key" ON "sender_list_entry"("tenant_id", "pattern");

-- CreateIndex
CREATE INDEX "routing_suggestion_tenant_id_status_idx" ON "routing_suggestion"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "routing_suggestion_tenant_id_pattern_key" ON "routing_suggestion"("tenant_id", "pattern");

-- AddForeignKey
ALTER TABLE "sender_list_entry" ADD CONSTRAINT "sender_list_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_suggestion" ADD CONSTRAINT "routing_suggestion_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

