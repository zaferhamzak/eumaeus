-- AlterTable
ALTER TABLE "rule" ADD COLUMN     "lineage_id" TEXT;

-- CreateIndex
CREATE INDEX "rule_tenant_id_lineage_id_idx" ON "rule"("tenant_id", "lineage_id");


-- Backfill: versions saved before lineage existed are grouped by organization
-- and name (an edit keeps the name unless it was renamed), under the id of the
-- group's earliest version.
UPDATE "rule" r
SET "lineage_id" = first."id"
FROM (
  SELECT DISTINCT ON ("tenant_id", "name") "tenant_id", "name", "id"
  FROM "rule"
  ORDER BY "tenant_id", "name", "version" ASC, "created_at" ASC
) AS first
WHERE r."tenant_id" = first."tenant_id" AND r."name" = first."name" AND r."lineage_id" IS NULL;
