-- AlterTable
ALTER TABLE "mailbox_connection" ADD COLUMN     "auth_type" TEXT NOT NULL DEFAULT 'password';

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "google_oauth_client_id" TEXT,
ADD COLUMN     "google_oauth_client_secret_encrypted" TEXT,
ADD COLUMN     "microsoft_oauth_client_id" TEXT,
ADD COLUMN     "microsoft_oauth_client_secret_encrypted" TEXT,
ADD COLUMN     "microsoft_oauth_tenant" TEXT NOT NULL DEFAULT 'common';

-- CreateTable
CREATE TABLE "mailbox_oauth_token" (
    "mailbox_connection_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT NOT NULL,
    "access_token_encrypted" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_oauth_token_pkey" PRIMARY KEY ("mailbox_connection_id")
);

-- AddForeignKey
ALTER TABLE "mailbox_oauth_token" ADD CONSTRAINT "mailbox_oauth_token_mailbox_connection_id_fkey" FOREIGN KEY ("mailbox_connection_id") REFERENCES "mailbox_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_oauth_token" ADD CONSTRAINT "mailbox_oauth_token_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

