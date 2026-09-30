"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCreateRuleGraph } from "@/hooks/useRuleGraphs";
import { RuleGraphEditor } from "@/components/ruleGraphs/RuleGraphEditor";
import { useT } from "@/lib/i18n/I18nProvider";

export default function NewRuleGraphPage() {
  const t = useT();
  const router = useRouter();
  const create = useCreateRuleGraph();

  return (
    <div className="space-y-4">
      <Link href="/rule-graphs" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("ruleGraphs.backToGraphs")}
      </Link>
      <h1 className="text-lg font-semibold text-foreground">{t("ruleGraphs.newTitle")}</h1>
      <RuleGraphEditor
        submitLabel={t("ruleGraphs.createGraph")}
        submitting={create.isPending}
        error={create.error}
        onSubmit={(input) => create.mutate(input, { onSuccess: (graph) => router.push(`/rule-graphs/${graph.id}`) })}
      />
    </div>
  );
}
