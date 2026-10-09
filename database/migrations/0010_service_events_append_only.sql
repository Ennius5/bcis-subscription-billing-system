-- Service history is append-only, like audit_logs (0004).
CREATE OR REPLACE FUNCTION service_events_block_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'service_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER service_events_no_update_delete
BEFORE UPDATE OR DELETE ON service_events
FOR EACH ROW EXECUTE FUNCTION service_events_block_modification();
