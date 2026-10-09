CREATE SEQUENCE "public"."service_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_number" text DEFAULT ('SVC-' || lpad(nextval('service_account_seq')::text, 6, '0')) NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"installation_address_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activation_date" date,
	"billing_start_date" date,
	"billing_day" integer NOT NULL,
	"current_rate_centavos" integer NOT NULL,
	"assigned_collector_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_accounts_service_number_unique" UNIQUE("service_number"),
	CONSTRAINT "service_accounts_status_valid" CHECK ("service_accounts"."status" IN ('pending', 'active', 'suspended', 'terminated')),
	CONSTRAINT "service_accounts_billing_day_valid" CHECK ("service_accounts"."billing_day" BETWEEN 1 AND 28),
	CONSTRAINT "service_accounts_rate_nonneg" CHECK ("service_accounts"."current_rate_centavos" >= 0),
	CONSTRAINT "service_accounts_dates_valid" CHECK (("service_accounts"."activation_date" IS NULL) = ("service_accounts"."billing_start_date" IS NULL) AND ("service_accounts"."billing_start_date" IS NULL OR "service_accounts"."billing_start_date" >= "service_accounts"."activation_date")),
	CONSTRAINT "service_accounts_activated_valid" CHECK ("service_accounts"."status" IN ('pending', 'terminated') OR "service_accounts"."activation_date" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "service_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"old_values" jsonb,
	"new_values" jsonb,
	"effective_date" date DEFAULT CURRENT_DATE NOT NULL,
	"reason" text,
	"actor_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_events_type_valid" CHECK ("service_events"."event_type" IN ('created', 'status_change', 'rate_change', 'plan_change', 'collector_change', 'update'))
);
--> statement-breakpoint
-- Moved above the foreign keys: service_accounts_installation_address_fk needs this unique index to exist first.
CREATE UNIQUE INDEX "subscriber_addresses_id_subscriber_idx" ON "subscriber_addresses" USING btree ("id","subscriber_id");--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_assigned_collector_id_collectors_id_fk" FOREIGN KEY ("assigned_collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_installation_address_fk" FOREIGN KEY ("installation_address_id","subscriber_id") REFERENCES "public"."subscriber_addresses"("id","subscriber_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_accounts_subscriber_idx" ON "service_accounts" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "service_accounts_plan_idx" ON "service_accounts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "service_accounts_status_idx" ON "service_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_accounts_collector_idx" ON "service_accounts" USING btree ("assigned_collector_id");--> statement-breakpoint
CREATE INDEX "service_events_account_idx" ON "service_events" USING btree ("service_account_id","occurred_at");