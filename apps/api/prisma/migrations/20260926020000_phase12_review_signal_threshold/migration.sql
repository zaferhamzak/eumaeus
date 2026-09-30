-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "human_review_signal_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "human_review_signal_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

