-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "last_review_digest_at" TIMESTAMP(3),
ADD COLUMN     "review_digest_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "review_digest_interval_minutes" INTEGER NOT NULL DEFAULT 60;

