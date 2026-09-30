-- 1.1 (B): the rename to Eumaeus changed this default in schema.prisma only.
-- Existing rows keep whatever name was saved (change it under Settings).
ALTER TABLE "system_settings" ALTER COLUMN "smtp_from_name" SET DEFAULT 'Eumaeus';
