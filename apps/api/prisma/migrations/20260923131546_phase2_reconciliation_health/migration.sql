-- AlterTable
ALTER TABLE "mailbox_connection" ADD COLUMN     "last_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_error" TEXT,
ADD COLUMN     "last_sync_failure_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_success_at" TIMESTAMP(3),
ADD COLUMN     "sync_locked_at" TIMESTAMP(3),
ADD COLUMN     "sync_status" TEXT NOT NULL DEFAULT 'idle';
