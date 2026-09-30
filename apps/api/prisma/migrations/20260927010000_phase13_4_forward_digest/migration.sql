-- CreateTable
CREATE TABLE "forward_digest_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "destination_channel_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "batch_id" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forward_digest_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forward_digest_batch" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "destination_channel_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "message_id" TEXT,
    "error_class" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "forward_digest_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forward_digest_item_destination_channel_id_status_queued_at_idx" ON "forward_digest_item"("destination_channel_id", "status", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "forward_digest_item_destination_channel_id_email_id_key" ON "forward_digest_item"("destination_channel_id", "email_id");

-- CreateIndex
CREATE INDEX "forward_digest_batch_destination_channel_id_created_at_idx" ON "forward_digest_batch"("destination_channel_id", "created_at");

-- CreateIndex
CREATE INDEX "forward_digest_batch_tenant_id_status_completed_at_idx" ON "forward_digest_batch"("tenant_id", "status", "completed_at");

-- AddForeignKey
ALTER TABLE "forward_digest_item" ADD CONSTRAINT "forward_digest_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_digest_item" ADD CONSTRAINT "forward_digest_item_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "destination_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_digest_item" ADD CONSTRAINT "forward_digest_item_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_digest_item" ADD CONSTRAINT "forward_digest_item_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "forward_digest_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_digest_batch" ADD CONSTRAINT "forward_digest_batch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_digest_batch" ADD CONSTRAINT "forward_digest_batch_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "destination_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

