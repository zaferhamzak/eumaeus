-- CreateTable
CREATE TABLE "analysis_result" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "jev_model" TEXT NOT NULL,
    "answers" JSONB,
    "status" TEXT NOT NULL,
    "error_class" TEXT,
    "error_message" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "input_truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_result_email_id_schema_version_status_idx" ON "analysis_result"("email_id", "schema_version", "status");

-- AddForeignKey
ALTER TABLE "analysis_result" ADD CONSTRAINT "analysis_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_result" ADD CONSTRAINT "analysis_result_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
