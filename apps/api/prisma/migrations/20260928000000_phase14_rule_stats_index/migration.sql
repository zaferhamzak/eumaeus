-- CreateIndex
CREATE INDEX "rule_evaluation_rule_id_matched_evaluated_at_idx" ON "rule_evaluation"("rule_id", "matched", "evaluated_at");

