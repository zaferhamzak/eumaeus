"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { CreateMailboxForm } from "@/components/mailboxes/CreateMailboxForm";
import { useT } from "@/lib/i18n/I18nProvider";

export default function NewMailboxPage() {
  const router = useRouter();
  const t = useT();

  return (
    <div className="space-y-4">
      <Link
        href="/mailboxes"
        className="text-xs text-foreground-muted hover:text-accent hover:underline"
      >
        {t("mailboxes.backToMailboxes")}
      </Link>
      <Card>
        <CardHeader title={t("mailboxes.newMailbox")} />
        <CardBody>
          <CreateMailboxForm onCreated={() => router.push("/mailboxes")} />
        </CardBody>
      </Card>
    </div>
  );
}
