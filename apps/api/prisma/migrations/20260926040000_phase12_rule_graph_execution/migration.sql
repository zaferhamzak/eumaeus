-- AlterTable
ALTER TABLE "routing_decision" ADD COLUMN     "graph_path" JSONB,
ADD COLUMN     "rule_graph_id" TEXT,
ADD COLUMN     "rule_graph_version" INTEGER;

-- AddForeignKey
ALTER TABLE "routing_decision" ADD CONSTRAINT "routing_decision_rule_graph_id_fkey" FOREIGN KEY ("rule_graph_id") REFERENCES "rule_graph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

