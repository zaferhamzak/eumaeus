-- CreateTable
CREATE TABLE "notify_queue_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "destination_channel_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notify_queue_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notify_channel_state" (
    "destination_channel_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notify_channel_state_pkey" PRIMARY KEY ("destination_channel_id")
);

-- CreateIndex
CREATE INDEX "notify_queue_item_destination_channel_id_queued_at_idx" ON "notify_queue_item"("destination_channel_id", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "notify_queue_item_destination_channel_id_email_id_key" ON "notify_queue_item"("destination_channel_id", "email_id");

-- AddForeignKey
ALTER TABLE "notify_queue_item" ADD CONSTRAINT "notify_queue_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_queue_item" ADD CONSTRAINT "notify_queue_item_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "destination_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_queue_item" ADD CONSTRAINT "notify_queue_item_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_channel_state" ADD CONSTRAINT "notify_channel_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_channel_state" ADD CONSTRAINT "notify_channel_state_destination_channel_id_fkey" FOREIGN KEY ("destination_channel_id") REFERENCES "destination_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

