-- Global search (spec 3.2) and the indexes spec 5.2 asks for on subscriber name, account and contact.
-- Searches are "contains" (ILIKE '%text%'), which a plain btree index cannot speed up; trigram
-- indexes can. pg_trgm is a trusted extension, so the database owner may create it.
-- These indexes are not declared in schema.ts (drizzle cannot express the extension), so
-- drizzle-kit never sees them and will not try to drop them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "subscribers_full_name_trgm_idx" ON "subscribers" USING gin ("full_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "subscribers_account_number_trgm_idx" ON "subscribers" USING gin ("account_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "service_accounts_service_number_trgm_idx" ON "service_accounts" USING gin ("service_number" gin_trgm_ops);
--> statement-breakpoint
-- Phone numbers are matched on their digits only. The search query must use this exact expression.
CREATE INDEX "subscriber_contacts_digits_trgm_idx" ON "subscriber_contacts"
  USING gin ((regexp_replace("value", '\D', '', 'g')) gin_trgm_ops);
--> statement-breakpoint
-- Emails and other contacts are matched as typed.
CREATE INDEX "subscriber_contacts_value_trgm_idx" ON "subscriber_contacts" USING gin ("value" gin_trgm_ops);
--> statement-breakpoint
-- One searchable line per address. The search query must use this exact expression.
CREATE INDEX "subscriber_addresses_search_trgm_idx" ON "subscriber_addresses"
  USING gin ((
    "line1" || ' ' || "barangay" || ' ' || "city" || ' ' || coalesce("province", '') || ' ' || coalesce("landmark", '')
  ) gin_trgm_ops);
