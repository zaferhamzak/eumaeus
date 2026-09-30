-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "sso_allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sso_google_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sso_microsoft_enabled" BOOLEAN NOT NULL DEFAULT false;

