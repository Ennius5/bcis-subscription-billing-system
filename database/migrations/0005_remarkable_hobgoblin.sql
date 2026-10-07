CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"service_type_id" uuid NOT NULL,
	"price_centavos" integer NOT NULL,
	"installation_fee_centavos" integer DEFAULT 0 NOT NULL,
	"reconnection_fee_centavos" integer DEFAULT 0 NOT NULL,
	"description" text,
	"speed_mbps" integer,
	"channel_count" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_plans_code_unique" UNIQUE("code"),
	CONSTRAINT "service_plans_price_nonneg" CHECK ("service_plans"."price_centavos" >= 0),
	CONSTRAINT "service_plans_fees_nonneg" CHECK ("service_plans"."installation_fee_centavos" >= 0 AND "service_plans"."reconnection_fee_centavos" >= 0),
	CONSTRAINT "service_plans_attributes_positive" CHECK (("service_plans"."speed_mbps" IS NULL OR "service_plans"."speed_mbps" > 0) AND ("service_plans"."channel_count" IS NULL OR "service_plans"."channel_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "service_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "service_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_plans_type_idx" ON "service_plans" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "service_plans_active_idx" ON "service_plans" USING btree ("is_active");