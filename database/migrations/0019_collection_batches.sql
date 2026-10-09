CREATE TABLE "batch_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"current_centavos" integer NOT NULL,
	"arrears_centavos" integer NOT NULL,
	"credit_centavos" integer NOT NULL,
	"total_due_centavos" integer NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_accounts_amounts_valid" CHECK ("batch_accounts"."current_centavos" >= 0 AND "batch_accounts"."arrears_centavos" >= 0 AND "batch_accounts"."credit_centavos" >= 0
        AND "batch_accounts"."total_due_centavos" = greatest(0, "batch_accounts"."current_centavos" + "batch_accounts"."arrears_centavos" - "batch_accounts"."credit_centavos"))
);
--> statement-breakpoint
CREATE TABLE "collection_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" text NOT NULL,
	"collector_id" uuid NOT NULL,
	"collection_area_id" uuid,
	"collection_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_by_user_id" uuid,
	"dispatched_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"expected_cash_centavos" integer,
	"remitted_cash_centavos" integer,
	"difference_centavos" integer,
	"variance_kind" text,
	"variance_reason" text,
	"reconciled_by_user_id" uuid,
	"reconciled_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "collection_batches_batch_number_unique" UNIQUE("batch_number"),
	CONSTRAINT "collection_batches_status_valid" CHECK ("collection_batches"."status" IN ('open', 'in_progress', 'submitted', 'remitted', 'reconciled', 'closed', 'cancelled')),
	CONSTRAINT "collection_batches_dispatch_shape" CHECK (("collection_batches"."dispatched_at" IS NULL) = ("collection_batches"."dispatched_by_user_id" IS NULL)
        AND ("collection_batches"."status" IN ('open', 'cancelled') OR "collection_batches"."dispatched_at" IS NOT NULL)),
	CONSTRAINT "collection_batches_submit_shape" CHECK (("collection_batches"."submitted_at" IS NULL) = ("collection_batches"."submitted_by_user_id" IS NULL)
        AND ("collection_batches"."status" IN ('open', 'in_progress', 'cancelled')) = ("collection_batches"."submitted_at" IS NULL)),
	CONSTRAINT "collection_batches_reconcile_shape" CHECK (("collection_batches"."status" IN ('reconciled', 'closed')) = ("collection_batches"."reconciled_at" IS NOT NULL)
        AND num_nonnulls("collection_batches"."reconciled_at", "collection_batches"."reconciled_by_user_id", "collection_batches"."expected_cash_centavos",
          "collection_batches"."remitted_cash_centavos", "collection_batches"."difference_centavos", "collection_batches"."variance_kind") IN (0, 6)),
	CONSTRAINT "collection_batches_variance_consistent" CHECK ("collection_batches"."reconciled_at" IS NULL OR (
        "collection_batches"."expected_cash_centavos" >= 0 AND "collection_batches"."remitted_cash_centavos" >= 0
        AND "collection_batches"."difference_centavos" = "collection_batches"."remitted_cash_centavos" - "collection_batches"."expected_cash_centavos"
        AND "collection_batches"."variance_kind" = CASE WHEN "collection_batches"."difference_centavos" = 0 THEN 'balanced'
          WHEN "collection_batches"."difference_centavos" < 0 THEN 'shortage' ELSE 'overage' END
        AND ("collection_batches"."difference_centavos" = 0 OR length(trim(coalesce("collection_batches"."variance_reason", ''))) >= 3))),
	CONSTRAINT "collection_batches_close_shape" CHECK (("collection_batches"."status" = 'closed') = ("collection_batches"."closed_at" IS NOT NULL) AND ("collection_batches"."closed_at" IS NULL) = ("collection_batches"."closed_by_user_id" IS NULL)),
	CONSTRAINT "collection_batches_cancel_shape" CHECK (("collection_batches"."status" = 'cancelled') = ("collection_batches"."cancelled_at" IS NOT NULL)
        AND num_nonnulls("collection_batches"."cancelled_at", "collection_batches"."cancelled_by_user_id", "collection_batches"."cancel_reason") IN (0, 3))
);
--> statement-breakpoint
CREATE TABLE "collector_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"amount_centavos" integer NOT NULL,
	"notes" text,
	"received_by_user_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "collector_remittances_amount_positive" CHECK ("collector_remittances"."amount_centavos" > 0),
	CONSTRAINT "collector_remittances_void_shape" CHECK (num_nonnulls("collector_remittances"."voided_at", "collector_remittances"."voided_by_user_id", "collector_remittances"."void_reason") IN (0, 3)
        AND ("collector_remittances"."void_reason" IS NULL OR length(trim("collector_remittances"."void_reason")) >= 3))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "collection_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "collector_id" uuid;--> statement-breakpoint
-- Moved up by hand: the composite foreign keys below need these unique indexes to exist first.
CREATE UNIQUE INDEX "batch_accounts_batch_subscriber_idx" ON "batch_accounts" USING btree ("batch_id","subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_batches_id_collector_idx" ON "collection_batches" USING btree ("id","collector_id");--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_collection_area_id_collection_areas_id_fk" FOREIGN KEY ("collection_area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_dispatched_by_user_id_users_id_fk" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_batch_fk" FOREIGN KEY ("batch_id","collector_id") REFERENCES "public"."collection_batches"("id","collector_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_accounts_subscriber_idx" ON "batch_accounts" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "collection_batches_collector_idx" ON "collection_batches" USING btree ("collector_id","collection_date");--> statement-breakpoint
CREATE INDEX "collection_batches_status_idx" ON "collection_batches" USING btree ("status","collection_date");--> statement-breakpoint
CREATE INDEX "collector_remittances_batch_idx" ON "collector_remittances" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "collector_remittances_collector_idx" ON "collector_remittances" USING btree ("collector_id","received_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_batch_account_fk" FOREIGN KEY ("collection_batch_id","subscriber_id") REFERENCES "public"."batch_accounts"("batch_id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_batch_collector_fk" FOREIGN KEY ("collection_batch_id","collector_id") REFERENCES "public"."collection_batches"("id","collector_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_batch_idx" ON "payments" USING btree ("collection_batch_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_field_collection_shape" CHECK (("payments"."collection_batch_id" IS NULL) = ("payments"."collector_id" IS NULL)
        AND ("payments"."collection_batch_id" IS NULL OR "payments"."method" IN ('cash', 'cheque')));