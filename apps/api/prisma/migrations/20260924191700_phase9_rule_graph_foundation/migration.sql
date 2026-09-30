-- CreateTable
CREATE TABLE "rule_graph" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_graph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_graph_version" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rule_graph_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "root_node_key" TEXT NOT NULL,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_graph_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_node" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "graph_version_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "on_true" JSONB NOT NULL,
    "on_false" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_node_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_graph_tenant_id_enabled_idx" ON "rule_graph"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "rule_graph_version_tenant_id_rule_graph_id_deactivated_at_idx" ON "rule_graph_version"("tenant_id", "rule_graph_id", "deactivated_at");

-- CreateIndex
CREATE UNIQUE INDEX "rule_graph_version_rule_graph_id_version_key" ON "rule_graph_version"("rule_graph_id", "version");

-- CreateIndex
CREATE INDEX "rule_node_graph_version_id_idx" ON "rule_node"("graph_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_node_graph_version_id_key_key" ON "rule_node"("graph_version_id", "key");

-- AddForeignKey
ALTER TABLE "rule_graph" ADD CONSTRAINT "rule_graph_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_graph_version" ADD CONSTRAINT "rule_graph_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_graph_version" ADD CONSTRAINT "rule_graph_version_rule_graph_id_fkey" FOREIGN KEY ("rule_graph_id") REFERENCES "rule_graph"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node" ADD CONSTRAINT "rule_node_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node" ADD CONSTRAINT "rule_node_graph_version_id_fkey" FOREIGN KEY ("graph_version_id") REFERENCES "rule_graph_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
