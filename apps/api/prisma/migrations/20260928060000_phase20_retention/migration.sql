-- AlterTable
ALTER TABLE "email" ADD COLUMN     "body_purged_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "body_retention_days" INTEGER,
ADD COLUMN     "email_retention_days" INTEGER;

