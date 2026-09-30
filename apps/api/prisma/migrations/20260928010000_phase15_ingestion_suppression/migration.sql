-- CreateTable
CREATE TABLE "ingestion_suppression" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mailbox_connection_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "message_id" TEXT,
    "uid_validity" INTEGER,
    "uid" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_suppression_mailbox_connection_id_message_id_idx" ON "ingestion_suppression"("mailbox_connection_id", "message_id");

-- CreateIndex
CREATE INDEX "ingestion_suppression_mailbox_connection_id_uid_validity_ui_idx" ON "ingestion_suppression"("mailbox_connection_id", "uid_validity", "uid");

-- CreateIndex
CREATE INDEX "ingestion_suppression_email_id_idx" ON "ingestion_suppression"("email_id");

-- AddForeignKey
ALTER TABLE "ingestion_suppression" ADD CONSTRAINT "ingestion_suppression_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_suppression" ADD CONSTRAINT "ingestion_suppression_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

