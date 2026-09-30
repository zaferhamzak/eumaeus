-- CreateTable
CREATE TABLE "outbound_email" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "kind" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "message_id" TEXT,
    "related_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_email_tenant_id_created_at_idx" ON "outbound_email"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_email_created_at_idx" ON "outbound_email"("created_at");

-- AddForeignKey
ALTER TABLE "outbound_email" ADD CONSTRAINT "outbound_email_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

