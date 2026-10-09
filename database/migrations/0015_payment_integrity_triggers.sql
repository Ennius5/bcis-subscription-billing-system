-- Payment rules the database itself enforces, so no code path (or direct SQL) can break them.

-- Receipt numbers start at RCPT-000001 and share the gapless counter used for invoices.
INSERT INTO document_sequences (name, prefix, next_value) VALUES ('receipt', 'RCPT-', 1)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- 1. Allocations, reversals and proofs are history: append-only, like the ledger (0013).
CREATE OR REPLACE FUNCTION block_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_no_update_delete
BEFORE UPDATE OR DELETE ON payment_allocations
FOR EACH ROW EXECUTE FUNCTION block_modification();
--> statement-breakpoint
CREATE TRIGGER payment_reversals_no_update_delete
BEFORE UPDATE OR DELETE ON payment_reversals
FOR EACH ROW EXECUTE FUNCTION block_modification();
--> statement-breakpoint
CREATE TRIGGER payment_proofs_no_update_delete
BEFORE UPDATE OR DELETE ON payment_proofs
FOR EACH ROW EXECUTE FUNCTION block_modification();
--> statement-breakpoint

-- 2. A posted payment is never edited or deleted (spec 3.6). Only allocated_centavos moves
--    (allocation, credit applied later) and posted -> reversed; a reversed payment is final.
CREATE OR REPLACE FUNCTION payments_protect_posted()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment % cannot be deleted; reverse it instead', OLD.receipt_number;
  END IF;

  IF OLD.status = 'reversed' THEN
    RAISE EXCEPTION 'payment % is reversed and cannot change', OLD.receipt_number;
  END IF;

  IF (NEW.receipt_number, NEW.subscriber_id, NEW.method, NEW.amount_centavos, NEW.payment_date,
      NEW.reference_number, NEW.notes, NEW.gcash_submission_id, NEW.received_by_user_id, NEW.posted_at)
     IS DISTINCT FROM
     (OLD.receipt_number, OLD.subscriber_id, OLD.method, OLD.amount_centavos, OLD.payment_date,
      OLD.reference_number, OLD.notes, OLD.gcash_submission_id, OLD.received_by_user_id, OLD.posted_at) THEN
    RAISE EXCEPTION 'payment % is posted; correct it by reversal, not by editing', OLD.receipt_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_protect_posted
BEFORE UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION payments_protect_posted();
--> statement-breakpoint

-- 3. GCash submissions: never deleted. A pending one may be corrected and then verified or
--    rejected. After review the details are frozen; the only later change is
--    verified -> reversed, when its payment is reversed. Rejected and reversed are final.
CREATE OR REPLACE FUNCTION gcash_submissions_protect_reviewed()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GCash submission % cannot be deleted; reject it instead', OLD.reference_number;
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status = 'reversed' THEN
      RAISE EXCEPTION 'a pending GCash submission cannot be reversed; reject it instead';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'verified' OR NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'GCash submission % is % and cannot change', OLD.reference_number, OLD.status;
  END IF;

  IF (NEW.subscriber_id, NEW.reference_number, NEW.sender_name, NEW.sender_number, NEW.amount_centavos,
      NEW.transaction_date, NEW.notes, NEW.recorded_by_user_id, NEW.recorded_at,
      NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.rejection_reason)
     IS DISTINCT FROM
     (OLD.subscriber_id, OLD.reference_number, OLD.sender_name, OLD.sender_number, OLD.amount_centavos,
      OLD.transaction_date, OLD.notes, OLD.recorded_by_user_id, OLD.recorded_at,
      OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.rejection_reason) THEN
    RAISE EXCEPTION 'GCash submission % was reviewed; its details cannot change', OLD.reference_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER gcash_submissions_protect_reviewed
BEFORE UPDATE OR DELETE ON gcash_submissions
FOR EACH ROW EXECUTE FUNCTION gcash_submissions_protect_reviewed();
