CREATE TABLE "backup_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"folder_name" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"database_bytes" bigint,
	"proof_file_count" integer,
	"proof_bytes" bigint,
	"manifest_sha256" text,
	"verification_status" text,
	"verified_at" timestamp with time zone,
	"verification_message" text,
	"error_message" text,
	CONSTRAINT "backup_history_backup_number_unique" UNIQUE("backup_number"),
	CONSTRAINT "backup_history_folder_name_unique" UNIQUE("folder_name"),
	CONSTRAINT "backup_history_kind_valid" CHECK ("backup_history"."kind" IN ('manual', 'scheduled', 'safety')),
	CONSTRAINT "backup_history_status_valid" CHECK ("backup_history"."status" IN ('in_progress', 'completed', 'failed')),
	CONSTRAINT "backup_history_verification_valid" CHECK ("backup_history"."verification_status" IS NULL OR "backup_history"."verification_status" IN ('passed', 'failed')),
	CONSTRAINT "backup_history_completed_shape" CHECK ("backup_history"."status" <> 'completed' OR ("backup_history"."completed_at" IS NOT NULL AND "backup_history"."manifest_sha256" IS NOT NULL
        AND "backup_history"."database_bytes" IS NOT NULL AND "backup_history"."proof_file_count" IS NOT NULL AND "backup_history"."proof_bytes" IS NOT NULL)),
	CONSTRAINT "backup_history_failed_shape" CHECK ("backup_history"."status" <> 'failed' OR "backup_history"."error_message" IS NOT NULL),
	CONSTRAINT "backup_history_in_progress_shape" CHECK ("backup_history"."status" <> 'in_progress' OR "backup_history"."completed_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_history_one_in_progress" ON "backup_history" USING btree ("status") WHERE "backup_history"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "backup_history_started_idx" ON "backup_history" USING btree ("started_at");