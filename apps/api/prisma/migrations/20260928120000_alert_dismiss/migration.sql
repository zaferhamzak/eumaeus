-- AlterTable
ALTER TABLE "alert" ADD COLUMN     "dismissed_at" TIMESTAMP(3),
ADD COLUMN     "dismissed_by" TEXT;

