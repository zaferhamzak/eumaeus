-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "app_base_url" TEXT NOT NULL DEFAULT 'http://localhost:3001',
    "session_ttl_seconds" INTEGER NOT NULL DEFAULT 86400,
    "mailbox_sync_interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "smtp_host" TEXT,
    "smtp_port" INTEGER NOT NULL DEFAULT 587,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT false,
    "smtp_username" TEXT,
    "smtp_password_encrypted" TEXT,
    "smtp_from_address" TEXT,
    "smtp_from_name" TEXT NOT NULL DEFAULT 'Jev Mail',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

