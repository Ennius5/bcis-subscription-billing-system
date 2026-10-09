-- Moved up by hand: the invoices and ledger_entries foreign keys below need this index to exist first.
CREATE UNIQUE INDEX "service_accounts_id_subscriber_idx" ON "service_accounts" USING btree ("id","subscriber_id");--> statement-breakpoint
CREATE TABLE "billing_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_cycles_period_start_unique" UNIQUE("period_start"),
	CONSTRAINT "billing_cycles_first_of_month" CHECK (extract(day from "billing_cycles"."period_start") = 1),
	CONSTRAINT "billing_cycles_whole_month" CHECK ("billing_cycles"."period_end" = ("billing_cycles"."period_start" + interval '1 month' - interval '1 day')::date)
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"name" text PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "document_sequences_next_positive" CHECK ("document_sequences"."next_value" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_type" text NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"plan_id" uuid,
	"rate_centavos" integer,
	CONSTRAINT "invoice_items_type_valid" CHECK ("invoice_items"."item_type" IN ('subscription', 'installation_fee', 'reconnection_fee', 'discount', 'penalty', 'adjustment')),
	CONSTRAINT "invoice_items_line_positive" CHECK ("invoice_items"."line_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text,
	"billing_cycle_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"service_account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_centavos" integer NOT NULL,
	"paid_centavos" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_by_user_id" uuid,
	"finalized_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" IN ('draft', 'unpaid', 'partially_paid', 'paid', 'void', 'credited')),
	CONSTRAINT "invoices_total_nonneg" CHECK ("invoices"."total_centavos" >= 0),
	CONSTRAINT "invoices_paid_range" CHECK ("invoices"."paid_centavos" >= 0 AND "invoices"."paid_centavos" <= "invoices"."total_centavos"),
	CONSTRAINT "invoices_period_valid" CHECK ("invoices"."period_end" >= "invoices"."period_start"),
	CONSTRAINT "invoices_due_after_issue" CHECK ("invoices"."due_date" >= "invoices"."invoice_date"),
	CONSTRAINT "invoices_draft_shape" CHECK (("invoices"."status" = 'draft') = ("invoices"."invoice_number" IS NULL) AND ("invoices"."status" = 'draft') = ("invoices"."finalized_at" IS NULL)),
	CONSTRAINT "invoices_void_shape" CHECK (("invoices"."status" = 'void') = ("invoices"."voided_at" IS NOT NULL) AND ("invoices"."status" <> 'void' OR "invoices"."void_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subscriber_id" uuid NOT NULL,
	"service_account_id" uuid,
	"entry_date" date NOT NULL,
	"entry_type" text NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"debit_centavos" integer DEFAULT 0 NOT NULL,
	"credit_centavos" integer DEFAULT 0 NOT NULL,
	"invoice_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_type_valid" CHECK ("ledger_entries"."entry_type" IN ('invoice', 'invoice_void', 'payment', 'payment_reversal', 'adjustment')),
	CONSTRAINT "ledger_entries_one_side" CHECK ("ledger_entries"."debit_centavos" >= 0 AND "ledger_entries"."credit_centavos" >= 0 AND ("ledger_entries"."debit_centavos" = 0) <> ("ledger_entries"."credit_centavos" = 0))
);
--> statement-breakpoint
ALTER TABLE "billing_cycles" ADD CONSTRAINT "billing_cycles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_cycle_id_billing_cycles_id_fk" FOREIGN KEY ("billing_cycle_id") REFERENCES "public"."billing_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_finalized_by_user_id_users_id_fk" FOREIGN KEY ("finalized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_account_fk" FOREIGN KEY ("service_account_id","subscriber_id") REFERENCES "public"."service_accounts"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_service_account_fk" FOREIGN KEY ("service_account_id","subscriber_id") REFERENCES "public"."service_accounts"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_line_idx" ON "invoice_items" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_period_idx" ON "invoices" USING btree ("service_account_id","period_start") WHERE "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_subscriber_idx" ON "invoices" USING btree ("subscriber_id","period_start");--> statement-breakpoint
CREATE INDEX "invoices_cycle_idx" ON "invoices" USING btree ("billing_cycle_id");--> statement-breakpoint
CREATE INDEX "invoices_due_date_idx" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_seq_idx" ON "ledger_entries" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_subscriber_idx" ON "ledger_entries" USING btree ("subscriber_id","entry_date","seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_invoice_idx" ON "ledger_entries" USING btree ("invoice_id");
