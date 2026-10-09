-- Phase 7 settings (spec 3.10: configurable grace period and suspension threshold).
-- Values are text in application_settings; @bcis/shared validates them as whole numbers.
INSERT INTO application_settings (key, value) VALUES
  ('grace_period_days', '7'),
  ('suspension_threshold_invoices', '1')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- 1. A suspension is history: never edited or deleted (block_modification is from 0015).
CREATE TRIGGER suspension_records_no_update_delete
BEFORE UPDATE OR DELETE ON suspension_records
FOR EACH ROW EXECUTE FUNCTION block_modification();
--> statement-breakpoint

-- 2. A reconnection only moves forward:
--    requested -> assigned | completed | cancelled
--    assigned  -> assigned (another technician) | completed | cancelled
--    completed and cancelled are final. What was requested (and the fee) never changes,
--    and once it leaves "assigned" the assignment is frozen too.
CREATE OR REPLACE FUNCTION reconnection_records_protect()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconnection records cannot be deleted; cancel them instead';
  END IF;

  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'reconnection % is % and cannot change', OLD.id, OLD.status;
  END IF;

  IF (NEW.service_account_id, NEW.suspension_record_id, NEW.request_date, NEW.requested_by_user_id,
      NEW.requested_at, NEW.fee_centavos, NEW.fee_waived, NEW.fee_waiver_reason, NEW.notes)
     IS DISTINCT FROM
     (OLD.service_account_id, OLD.suspension_record_id, OLD.request_date, OLD.requested_by_user_id,
      OLD.requested_at, OLD.fee_centavos, OLD.fee_waived, OLD.fee_waiver_reason, OLD.notes) THEN
    RAISE EXCEPTION 'the request details of reconnection % cannot change', OLD.id;
  END IF;

  IF NOT (
    (OLD.status = 'requested' AND NEW.status IN ('assigned', 'completed', 'cancelled'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('assigned', 'completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'reconnection cannot move from % to %', OLD.status, NEW.status;
  END IF;

  IF OLD.status = 'assigned' AND NEW.status <> 'assigned'
     AND (NEW.technician_user_id, NEW.assigned_by_user_id, NEW.assigned_at)
         IS DISTINCT FROM (OLD.technician_user_id, OLD.assigned_by_user_id, OLD.assigned_at) THEN
    RAISE EXCEPTION 'the assignment of reconnection % cannot change when it is %', OLD.id, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER reconnection_records_protect
BEFORE UPDATE OR DELETE ON reconnection_records
FOR EACH ROW EXECUTE FUNCTION reconnection_records_protect();
