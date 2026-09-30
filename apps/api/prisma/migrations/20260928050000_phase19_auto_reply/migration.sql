-- AlterTable
ALTER TABLE "email" ADD COLUMN     "auto_submitted" TEXT,
ADD COLUMN     "headers_captured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "list_id" TEXT,
ADD COLUMN     "precedence" TEXT,
ADD COLUMN     "reply_to_address" TEXT,
ADD COLUMN     "sender_name" TEXT;

-- CreateTable
CREATE TABLE "auto_reply_record" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_reply_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auto_reply_record_tenant_id_destination_id_recipient_key" ON "auto_reply_record"("tenant_id", "destination_id", "recipient");

-- AddForeignKey
ALTER TABLE "auto_reply_record" ADD CONSTRAINT "auto_reply_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

