-- Global search by receipt number, invoice number and GCash reference (spec 3.2), as
-- "contains" matches like the other search fields, so trigram indexes as in 0011.
-- Like 0011, these are not declared in schema.ts, so drizzle-kit leaves them alone.
CREATE INDEX "payments_receipt_number_trgm_idx" ON "payments" USING gin ("receipt_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoices_invoice_number_trgm_idx" ON "invoices" USING gin ("invoice_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "gcash_submissions_reference_trgm_idx" ON "gcash_submissions" USING gin ("reference_number" gin_trgm_ops);
