-- AlterTable
ALTER TABLE "email" ADD COLUMN     "sender_auth" JSONB,
ADD COLUMN     "sender_auth_captured" BOOLEAN NOT NULL DEFAULT false;

