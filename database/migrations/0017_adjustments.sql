CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_number" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustments_adjustment_number_unique" UNIQUE("adjustment_number"),
	CONSTRAINT "adjustments_amount_positive" CHECK ("adjustments"."amount_centavos" > 0),
	CONSTRAINT "adjustments_category_valid" CHECK (("adjustments"."kind" = 'credit' AND "adjustments"."category" IN ('discount', 'service_outage', 'billing_error', 'goodwill', 'other'))
        OR ("adjustments"."kind" = 'debit' AND "adjustments"."category" IN ('penalty', 'reconnection_fee', 'billing_error', 'other'))),
	CONSTRAINT "adjustments_reason_present" CHECK (length(trim("adjustments"."reason")) >= 3)
);
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_paid_range";--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_draft_unpaid";--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_paid_status_consistent";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "adjusted_centavos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "adjustment_id" uuid;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_invoice_fk" FOREIGN KEY ("invoice_id","subscriber_id") REFERENCES "public"."invoices"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustments_invoice_idx" ON "adjustments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "adjustments_subscriber_idx" ON "adjustments" USING btree ("subscriber_id","created_at");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_adjustment_id_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_adjustment_idx" ON "ledger_entries" USING btree ("adjustment_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_effective_total_nonneg" CHECK ("invoices"."total_centavos" + "invoices"."adjusted_centavos" >= 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_range" CHECK ("invoices"."paid_centavos" >= 0 AND "invoices"."paid_centavos" <= "invoices"."total_centavos" + "invoices"."adjusted_centavos");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_draft_unpaid" CHECK ("invoices"."status" <> 'draft' OR ("invoices"."paid_centavos" = 0 AND "invoices"."adjusted_centavos" = 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_status_consistent" CHECK ("invoices"."status" NOT IN ('unpaid', 'partially_paid', 'paid', 'credited') OR "invoices"."status" = CASE
        WHEN "invoices"."total_centavos" + "invoices"."adjusted_centavos" = 0 AND "invoices"."adjusted_centavos" < 0 THEN 'credited'
        WHEN "invoices"."paid_centavos" = "invoices"."total_centavos" + "invoices"."adjusted_centavos" THEN 'paid'
        WHEN "invoices"."paid_centavos" = 0 THEN 'unpaid'
        ELSE 'partially_paid' END);