-- AlterTable
ALTER TABLE "mailbox_connection" ADD COLUMN     "name" TEXT,
ADD COLUMN     "rule_graph_id" TEXT;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "mailbox_credential" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mailbox_connection_id" TEXT NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_credential_mailbox_connection_id_key" ON "mailbox_credential"("mailbox_connection_id");

-- CreateIndex
CREATE INDEX "mailbox_connection_tenant_id_idx" ON "mailbox_connection"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- AddForeignKey
ALTER TABLE "mailbox_connection" ADD CONSTRAINT "mailbox_connection_rule_graph_id_fkey" FOREIGN KEY ("rule_graph_id") REFERENCES "rule_graph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_credential" ADD CONSTRAINT "mailbox_credential_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_credential" ADD CONSTRAINT "mailbox_credential_mailbox_connection_id_fkey" FOREIGN KEY ("mailbox_connection_id") REFERENCES "mailbox_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

