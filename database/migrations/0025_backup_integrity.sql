-- Backup numbers BK-000001, gapless like the other document series.
INSERT INTO document_sequences (name, prefix, next_value) VALUES ('backup', 'BK-', 1)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- Backup history is evidence (spec 5, Phase 9 decision 3):
--   * rows are never deleted;
--   * who started a backup, when, what kind and where it lives never change;
--   * in_progress ends once, as completed or failed, and the result is then frozen;
--   * only the verification fields may be updated later (a backup can be re-checked).
CREATE OR REPLACE FUNCTION backup_history_protect()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'backup history cannot be deleted';
  END IF;

  IF (NEW.id, NEW.backup_number, NEW.kind, NEW.folder_name, NEW.note, NEW.created_by_user_id, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.backup_number, OLD.kind, OLD.folder_name, OLD.note, OLD.created_by_user_id, OLD.started_at) THEN
    RAISE EXCEPTION 'the details of backup % cannot change', OLD.backup_number;
  END IF;

  IF OLD.status = 'in_progress' THEN
    IF NEW.status NOT IN ('in_progress', 'completed', 'failed') THEN
      RAISE EXCEPTION 'backup cannot move from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.status, NEW.completed_at, NEW.database_bytes, NEW.proof_file_count, NEW.proof_bytes,
      NEW.manifest_sha256, NEW.error_message)
     IS DISTINCT FROM
     (OLD.status, OLD.completed_at, OLD.database_bytes, OLD.proof_file_count, OLD.proof_bytes,
      OLD.manifest_sha256, OLD.error_message) THEN
    RAISE EXCEPTION 'backup % is % and its result cannot change', OLD.backup_number, OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER backup_history_protect
BEFORE UPDATE OR DELETE ON backup_history
FOR EACH ROW EXECUTE FUNCTION backup_history_protect();
