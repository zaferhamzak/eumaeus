"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { RuleForm } from "@/components/rules/RuleForm";
import { useCreateRule } from "@/hooks/useRules";
import { defaultLeaf } from "@/components/rules/ConditionEditor";
import { useT } from "@/lib/i18n/I18nProvider";

export default function NewRulePage() {
  const t = useT();
  const router = useRouter();
  const create = useCreateRule();

  return (
    <div className="space-y-4">
      <Link href="/rules" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("rules.backToRules")}
      </Link>
      <Card>
        <CardHeader title={t("rules.newRule")} />
        <CardBody>
          <RuleForm
            initial={{ name: "", priority: 10, destinationRef: "", conditions: defaultLeaf() }}
            submitLabel={t("rules.createRule")}
            isSubmitting={create.isPending}
            submitError={create.error}
            onSubmit={(input, options) => create.mutate({ input, ...options }, { onSuccess: (rule) => router.push(`/rules/${rule.id}`) })}
          />
        </CardBody>
      </Card>
    </div>
  );
}
