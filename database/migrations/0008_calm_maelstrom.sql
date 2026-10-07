CREATE SEQUENCE "public"."subscriber_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "collector_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"collection_area_id" uuid,
	"collector_id" uuid,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"assigned_by_user_id" uuid NOT NULL,
	"reason" text,
	CONSTRAINT "collector_assignments_period_valid" CHECK ("collector_assignments"."effective_to" IS NULL OR "collector_assignments"."effective_to" >= "collector_assignments"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "subscriber_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"label" text,
	"line1" text NOT NULL,
	"barangay" text NOT NULL,
	"city" text NOT NULL,
	"province" text,
	"landmark" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"contact_name" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriber_contacts_type_valid" CHECK ("subscriber_contacts"."type" IN ('mobile', 'landline', 'email', 'other'))
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_number" text DEFAULT ('BCIS-' || lpad(nextval('subscriber_account_seq')::text, 6, '0')) NOT NULL,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"billing_day" integer NOT NULL,
	"collection_area_id" uuid,
	"assigned_collector_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_account_number_unique" UNIQUE("account_number"),
	CONSTRAINT "subscribers_status_valid" CHECK ("subscribers"."status" IN ('active', 'inactive', 'terminated', 'archived')),
	CONSTRAINT "subscribers_billing_day_valid" CHECK ("subscribers"."billing_day" BETWEEN 1 AND 28)
);
--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_collection_area_id_collection_areas_id_fk" FOREIGN KEY ("collection_area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_contacts" ADD CONSTRAINT "subscriber_contacts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_collection_area_id_collection_areas_id_fk" FOREIGN KEY ("collection_area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_assigned_collector_id_collectors_id_fk" FOREIGN KEY ("assigned_collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collector_assignments_subscriber_idx" ON "collector_assignments" USING btree ("subscriber_id","effective_from");--> statement-breakpoint
CREATE INDEX "collector_assignments_collector_idx" ON "collector_assignments" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "collector_assignments_area_idx" ON "collector_assignments" USING btree ("collection_area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_assignments_one_open_idx" ON "collector_assignments" USING btree ("subscriber_id") WHERE "collector_assignments"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "subscriber_addresses_subscriber_idx" ON "subscriber_addresses" USING btree ("subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_addresses_one_primary_idx" ON "subscriber_addresses" USING btree ("subscriber_id") WHERE "subscriber_addresses"."is_primary";--> statement-breakpoint
CREATE INDEX "subscriber_contacts_subscriber_idx" ON "subscriber_contacts" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "subscriber_contacts_value_idx" ON "subscriber_contacts" USING btree ("value");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_contacts_one_primary_idx" ON "subscriber_contacts" USING btree ("subscriber_id") WHERE "subscriber_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "subscribers_full_name_idx" ON "subscribers" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscribers_area_idx" ON "subscribers" USING btree ("collection_area_id");--> statement-breakpoint
CREATE INDEX "subscribers_collector_idx" ON "subscribers" USING btree ("assigned_collector_id");