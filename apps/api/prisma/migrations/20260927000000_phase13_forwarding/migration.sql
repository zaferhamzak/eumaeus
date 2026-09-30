-- AlterTable
ALTER TABLE "email" ADD COLUMN     "forwarded_by_jev_mail" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "raw_source_retention_days" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "forward_allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "forward_daily_limit" INTEGER NOT NULL DEFAULT 200;

-- CreateTable
CREATE TABLE "email_source" (
    "email_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_source_pkey" PRIMARY KEY ("email_id")
);

-- CreateTable
CREATE TABLE "forward_recipient" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "token_hash" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "requested_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forward_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_source_expires_at_idx" ON "email_source"("expires_at");

-- CreateIndex
CREATE INDEX "forward_recipient_token_hash_idx" ON "forward_recipient"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "forward_recipient_tenant_id_address_key" ON "forward_recipient"("tenant_id", "address");

-- AddForeignKey
ALTER TABLE "email_source" ADD CONSTRAINT "email_source_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_source" ADD CONSTRAINT "email_source_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forward_recipient" ADD CONSTRAINT "forward_recipient_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

