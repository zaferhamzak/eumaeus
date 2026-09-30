-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_connection" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email_address" TEXT NOT NULL,
    "provider_config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_uid_validity" INTEGER,
    "last_synced_uid" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mailbox_connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "uid_validity" INTEGER NOT NULL,
    "message_id" TEXT,
    "thread_id" TEXT,
    "from_address" TEXT NOT NULL,
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[],
    "bcc_addresses" TEXT[],
    "subject" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "text_body" TEXT,
    "html_body" TEXT,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "attachment_meta" JSONB,
    "state" TEXT NOT NULL,
    "state_updated_at" TIMESTAMP(3) NOT NULL,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" JSONB,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_review_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_to" TEXT,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "human_review_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_tenant_id_state_idx" ON "email"("tenant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "email_mailbox_connection_id_uid_validity_external_id_key" ON "email"("mailbox_connection_id", "uid_validity", "external_id");

-- CreateIndex
CREATE INDEX "audit_event_email_id_idx" ON "audit_event"("email_id");

-- AddForeignKey
ALTER TABLE "mailbox_connection" ADD CONSTRAINT "mailbox_connection_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email" ADD CONSTRAINT "email_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email" ADD CONSTRAINT "email_mailbox_connection_id_fkey" FOREIGN KEY ("mailbox_connection_id") REFERENCES "mailbox_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_review_item" ADD CONSTRAINT "human_review_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_review_item" ADD CONSTRAINT "human_review_item_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
