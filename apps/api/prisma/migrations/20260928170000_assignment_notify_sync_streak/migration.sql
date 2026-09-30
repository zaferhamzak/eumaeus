-- AlterTable
ALTER TABLE "human_review_item" ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "assignment_notified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "mailbox_connection" ADD COLUMN     "consecutive_sync_failures" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "assignment_notify_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "assignment_notify_threshold" INTEGER NOT NULL DEFAULT 1;


-- A mailbox whose latest sync failed has failed at least once in a row; the
-- real streak is unknown before this column existed, so start it at 1.
UPDATE "mailbox_connection" SET "consecutive_sync_failures" = 1
WHERE "last_sync_failure_at" IS NOT NULL
  AND ("last_sync_success_at" IS NULL OR "last_sync_failure_at" > "last_sync_success_at");
