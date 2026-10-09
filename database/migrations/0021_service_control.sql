CREATE TABLE "reconnection_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"suspension_record_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"request_date" date NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fee_centavos" integer NOT NULL,
	"fee_waived" boolean DEFAULT false NOT NULL,
	"fee_waiver_reason" text,
	"notes" text,
	"technician_user_id" uuid,
	"assigned_by_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"completion_date" date,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "reconnection_records_status_valid" CHECK ("reconnection_records"."status" IN ('requested', 'assigned', 'completed', 'cancelled')),
	CONSTRAINT "reconnection_records_fee_nonneg" CHECK ("reconnection_records"."fee_centavos" >= 0),
	CONSTRAINT "reconnection_records_waiver_shape" CHECK ("reconnection_records"."fee_waived" = ("reconnection_records"."fee_waiver_reason" IS NOT NULL)),
	CONSTRAINT "reconnection_records_assignment_shape" CHECK (num_nonnulls("reconnection_records"."technician_user_id", "reconnection_records"."assigned_by_user_id", "reconnection_records"."assigned_at") IN (0, 3)
        AND ("reconnection_records"."status" <> 'assigned' OR "reconnection_records"."technician_user_id" IS NOT NULL)),
	CONSTRAINT "reconnection_records_completion_shape" CHECK (("reconnection_records"."status" = 'completed') = (num_nonnulls("reconnection_records"."completion_date", "reconnection_records"."completed_by_user_id", "reconnection_records"."completed_at") = 3)
        AND num_nonnulls("reconnection_records"."completion_date", "reconnection_records"."completed_by_user_id", "reconnection_records"."completed_at") IN (0, 3)
        AND ("reconnection_records"."completion_date" IS NULL OR "reconnection_records"."completion_date" >= "reconnection_records"."request_date")),
	CONSTRAINT "reconnection_records_cancel_shape" CHECK (("reconnection_records"."status" = 'cancelled') = (num_nonnulls("reconnection_records"."cancel_reason", "reconnection_records"."cancelled_by_user_id", "reconnection_records"."cancelled_at") = 3)
        AND num_nonnulls("reconnection_records"."cancel_reason", "reconnection_records"."cancelled_by_user_id", "reconnection_records"."cancelled_at") IN (0, 3))
);
--> statement-breakpoint
CREATE TABLE "suspension_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"reason" text NOT NULL,
	"approved_by" text NOT NULL,
	"notes" text,
	"past_due_invoice_count" integer NOT NULL,
	"past_due_centavos" integer NOT NULL,
	"suspended_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspension_records_reason_present" CHECK (length(trim("suspension_records"."reason")) > 0),
	CONSTRAINT "suspension_records_approved_by_present" CHECK (length(trim("suspension_records"."approved_by")) > 0),
	CONSTRAINT "suspension_records_snapshot_nonneg" CHECK ("suspension_records"."past_due_invoice_count" >= 0 AND "suspension_records"."past_due_centavos" >= 0)
);
--> statement-breakpoint
-- Moved up by hand: the composite FK from reconnection_records needs this unique index first.
CREATE UNIQUE INDEX "suspension_records_id_account_idx" ON "suspension_records" USING btree ("id","service_account_id");--> statement-breakpoint
ALTER TABLE "service_events" DROP CONSTRAINT "service_events_type_valid";--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "reconnection_id" uuid;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_technician_user_id_users_id_fk" FOREIGN KEY ("technician_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_suspension_fk" FOREIGN KEY ("suspension_record_id","service_account_id") REFERENCES "public"."suspension_records"("id","service_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_suspended_by_user_id_users_id_fk" FOREIGN KEY ("suspended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconnection_records_account_idx" ON "reconnection_records" USING btree ("service_account_id","requested_at");--> statement-breakpoint
CREATE INDEX "reconnection_records_status_idx" ON "reconnection_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconnection_records_technician_idx" ON "reconnection_records" USING btree ("technician_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconnection_records_one_live_idx" ON "reconnection_records" USING btree ("service_account_id") WHERE "reconnection_records"."status" IN ('requested', 'assigned');--> statement-breakpoint
CREATE UNIQUE INDEX "reconnection_records_one_per_suspension_idx" ON "reconnection_records" USING btree ("suspension_record_id") WHERE "reconnection_records"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "suspension_records_account_idx" ON "suspension_records" USING btree ("service_account_id","created_at");--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_reconnection_id_reconnection_records_id_fk" FOREIGN KEY ("reconnection_id") REFERENCES "public"."reconnection_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_items_reconnection_idx" ON "invoice_items" USING btree ("reconnection_id");--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_reconnection_fee_only" CHECK ("invoice_items"."reconnection_id" IS NULL OR "invoice_items"."item_type" = 'reconnection_fee');--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_type_valid" CHECK ("service_events"."event_type" IN ('created', 'status_change', 'rate_change', 'plan_change', 'collector_change', 'update', 'reconnection_request', 'reconnection_assign', 'reconnection_cancel'));