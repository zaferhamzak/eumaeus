-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "locale" TEXT;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';

