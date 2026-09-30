-- Phase 22: sender history conditions compare addresses case-insensitively.
CREATE INDEX "email_tenant_lower_from_received_idx" ON "email" ("tenant_id", lower("from_address"), "received_at");
