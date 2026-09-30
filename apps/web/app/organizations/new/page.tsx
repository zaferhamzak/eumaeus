"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { useCreateOrganization } from "@/hooks/useOrganizations";
import { useT } from "@/lib/i18n/I18nProvider";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function NewOrganizationPage() {
  const t = useT();
  const router = useRouter();
  const create = useCreateOrganization();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setValidationError(t("organizations.nameEmpty"));
      return;
    }
    if (!SLUG_PATTERN.test(slug)) {
      setValidationError(t("organizations.slugInvalid"));
      return;
    }
    setValidationError(null);
    create.mutate({ name, slug }, { onSuccess: (org) => router.push(`/organizations/${org.id}`) });
  }

  return (
    <div className="space-y-4">
      <Link href="/organizations" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("organizations.backToList")}
      </Link>
      <Card>
        <CardHeader title={t("organizations.newOrganization")} />
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-5">
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.colName")}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                placeholder="Acme Security"
                required
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.colSlug")}</span>
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                placeholder="acme-security"
                required
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
              />
            </label>

            {validationError ? (
              <p className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
                {validationError}
              </p>
            ) : null}
            {create.isError ? (
              <p className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
                {create.error instanceof ApiRequestError ? create.error.message : t("organizations.createFailed")}
              </p>
            ) : null}

            <Button type="submit" variant="primary" loading={create.isPending}>
              {t("organizations.createOrganization")}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
