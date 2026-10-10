CREATE TABLE "integrity_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"backup_id" uuid,
	"passed" boolean NOT NULL,
	"results" jsonb NOT NULL,
	"run_by_user_id" uuid,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrity_checks_scope_valid" CHECK ("integrity_checks"."scope" IN ('live', 'test_restore', 'after_restore')),
	CONSTRAINT "integrity_checks_backup_for_restores" CHECK ("integrity_checks"."scope" = 'live' OR "integrity_checks"."backup_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "integrity_checks" ADD CONSTRAINT "integrity_checks_backup_id_backup_history_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backup_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_checks" ADD CONSTRAINT "integrity_checks_run_by_user_id_users_id_fk" FOREIGN KEY ("run_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integrity_checks_ran_idx" ON "integrity_checks" USING btree ("ran_at");--> statement-breakpoint
-- Integrity check results are evidence: never edited or deleted (block_modification is from 0015).
CREATE TRIGGER integrity_checks_no_update_delete
BEFORE UPDATE OR DELETE ON integrity_checks
FOR EACH ROW EXECUTE FUNCTION block_modification();
