CREATE TABLE "gcash_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"reference_number" text NOT NULL,
	"sender_name" text NOT NULL,
	"sender_number" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"transaction_date" date NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	CONSTRAINT "gcash_submissions_status_valid" CHECK ("gcash_submissions"."status" IN ('pending', 'verified', 'rejected', 'reversed')),
	CONSTRAINT "gcash_submissions_amount_positive" CHECK ("gcash_submissions"."amount_centavos" > 0),
	CONSTRAINT "gcash_submissions_review_shape" CHECK (("gcash_submissions"."status" = 'pending') = ("gcash_submissions"."reviewed_at" IS NULL) AND ("gcash_submissions"."reviewed_at" IS NULL) = ("gcash_submissions"."reviewed_by_user_id" IS NULL) AND ("gcash_submissions"."status" = 'rejected') = ("gcash_submissions"."rejection_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"amount_centavos" integer NOT NULL,
	"source" text NOT NULL,
	"allocated_by_user_id" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_positive" CHECK ("payment_allocations"."amount_centavos" > 0),
	CONSTRAINT "payment_allocations_source_valid" CHECK ("payment_allocations"."source" IN ('auto', 'manual', 'credit'))
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gcash_submission_id" uuid,
	"payment_id" uuid,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proofs_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "payment_proofs_one_owner" CHECK (num_nonnulls("payment_proofs"."gcash_submission_id", "payment_proofs"."payment_id") = 1),
	CONSTRAINT "payment_proofs_mime_valid" CHECK ("payment_proofs"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "payment_proofs_size_valid" CHECK ("payment_proofs"."size_bytes" > 0 AND "payment_proofs"."size_bytes" <= 5242880),
	CONSTRAINT "payment_proofs_sha256_shape" CHECK ("payment_proofs"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payment_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reversed_by_user_id" uuid NOT NULL,
	"reversed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reversals_payment_id_unique" UNIQUE("payment_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"allocated_centavos" integer DEFAULT 0 NOT NULL,
	"payment_date" date NOT NULL,
	"reference_number" text,
	"notes" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"gcash_submission_id" uuid,
	"received_by_user_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "payments_gcash_submission_id_unique" UNIQUE("gcash_submission_id"),
	CONSTRAINT "payments_method_valid" CHECK ("payments"."method" IN ('cash', 'gcash', 'bank_transfer', 'cheque', 'other')),
	CONSTRAINT "payments_status_valid" CHECK ("payments"."status" IN ('posted', 'reversed')),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_centavos" > 0),
	CONSTRAINT "payments_allocated_range" CHECK ("payments"."allocated_centavos" >= 0 AND "payments"."allocated_centavos" <= "payments"."amount_centavos"),
	CONSTRAINT "payments_gcash_shape" CHECK (("payments"."method" = 'gcash') = ("payments"."gcash_submission_id" IS NOT NULL) AND ("payments"."method" <> 'gcash' OR "payments"."reference_number" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
-- Moved up by hand: the payment_allocations foreign keys below need these two indexes to exist first.
CREATE UNIQUE INDEX "payments_id_subscriber_idx" ON "payments" USING btree ("id","subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_id_subscriber_idx" ON "invoices" USING btree ("id","subscriber_id");--> statement-breakpoint
ALTER TABLE "gcash_submissions" ADD CONSTRAINT "gcash_submissions_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcash_submissions" ADD CONSTRAINT "gcash_submissions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcash_submissions" ADD CONSTRAINT "gcash_submissions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_allocated_by_user_id_users_id_fk" FOREIGN KEY ("allocated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("payment_id","subscriber_id") REFERENCES "public"."payments"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_fk" FOREIGN KEY ("invoice_id","subscriber_id") REFERENCES "public"."invoices"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_gcash_submission_id_gcash_submissions_id_fk" FOREIGN KEY ("gcash_submission_id") REFERENCES "public"."gcash_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gcash_submission_id_gcash_submissions_id_fk" FOREIGN KEY ("gcash_submission_id") REFERENCES "public"."gcash_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gcash_submissions_live_reference_idx" ON "gcash_submissions" USING btree ("reference_number") WHERE "gcash_submissions"."status" IN ('pending', 'verified');--> statement-breakpoint
CREATE INDEX "gcash_submissions_status_idx" ON "gcash_submissions" USING btree ("status","recorded_at");--> statement-breakpoint
CREATE INDEX "gcash_submissions_subscriber_idx" ON "gcash_submissions" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_proofs_submission_idx" ON "payment_proofs" USING btree ("gcash_submission_id");--> statement-breakpoint
CREATE INDEX "payment_proofs_payment_idx" ON "payment_proofs" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_subscriber_idx" ON "payments" USING btree ("subscriber_id","payment_date");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "payments_reference_idx" ON "payments" USING btree ("reference_number");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_idx" ON "ledger_entries" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_draft_unpaid" CHECK ("invoices"."status" <> 'draft' OR "invoices"."paid_centavos" = 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_status_consistent" CHECK ("invoices"."status" NOT IN ('unpaid', 'partially_paid', 'paid') OR "invoices"."status" = CASE WHEN "invoices"."paid_centavos" = "invoices"."total_centavos" THEN 'paid' WHEN "invoices"."paid_centavos" = 0 THEN 'unpaid' ELSE 'partially_paid' END);