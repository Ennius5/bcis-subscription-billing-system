-- Collection rules the database itself enforces (spec 3.8), so no code path or direct SQL
-- can break them. The services check the same things first to give friendly messages.

-- Batch numbers start at CB-000001 and share the gapless counter used for invoices and receipts.
INSERT INTO document_sequences (name, prefix, next_value) VALUES ('collection_batch', 'CB-', 1)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- 1. Batches are never deleted and follow the lifecycle:
--    open -> in_progress | cancelled; in_progress -> submitted | cancelled;
--    submitted -> remitted | reconciled; remitted -> reconciled; reconciled -> closed.
--    Closed and cancelled are final, and the figures a batch was reconciled on never change.
CREATE OR REPLACE FUNCTION collection_batches_protect()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'collection batch % cannot be deleted; cancel it instead', OLD.batch_number;
  END IF;

  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'collection batch % is % and cannot change', OLD.batch_number, OLD.status;
  END IF;

  IF (NEW.batch_number, NEW.collector_id, NEW.collection_area_id, NEW.collection_date,
      NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.batch_number, OLD.collector_id, OLD.collection_area_id, OLD.collection_date,
      OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'collection batch %: number, collector, area and date cannot change', OLD.batch_number;
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('remitted', 'reconciled'))
    OR (OLD.status = 'remitted' AND NEW.status = 'reconciled')
    OR (OLD.status = 'reconciled' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'collection batch % cannot move from % to %', OLD.batch_number, OLD.status, NEW.status;
  END IF;

  -- Who dispatched and submitted it, once recorded, stays recorded.
  IF OLD.dispatched_at IS NOT NULL
     AND (NEW.dispatched_at, NEW.dispatched_by_user_id) IS DISTINCT FROM (OLD.dispatched_at, OLD.dispatched_by_user_id) THEN
    RAISE EXCEPTION 'collection batch %: dispatch details cannot change', OLD.batch_number;
  END IF;
  IF OLD.submitted_at IS NOT NULL
     AND (NEW.submitted_at, NEW.submitted_by_user_id) IS DISTINCT FROM (OLD.submitted_at, OLD.submitted_by_user_id) THEN
    RAISE EXCEPTION 'collection batch %: submission details cannot change', OLD.batch_number;
  END IF;

  IF OLD.status = 'reconciled'
     AND (NEW.expected_cash_centavos, NEW.remitted_cash_centavos, NEW.difference_centavos, NEW.variance_kind,
          NEW.variance_reason, NEW.reconciled_by_user_id, NEW.reconciled_at)
     IS DISTINCT FROM
     (OLD.expected_cash_centavos, OLD.remitted_cash_centavos, OLD.difference_centavos, OLD.variance_kind,
      OLD.variance_reason, OLD.reconciled_by_user_id, OLD.reconciled_at) THEN
    RAISE EXCEPTION 'collection batch % is reconciled; its figures cannot change', OLD.batch_number;
  END IF;

  IF NEW.status = 'cancelled' AND EXISTS (SELECT 1 FROM payments WHERE collection_batch_id = OLD.id) THEN
    RAISE EXCEPTION 'collection batch % has recorded collections and cannot be cancelled', OLD.batch_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER collection_batches_protect
BEFORE UPDATE OR DELETE ON collection_batches
FOR EACH ROW EXECUTE FUNCTION collection_batches_protect();
--> statement-breakpoint

-- 2. Route sheet rows are a snapshot: never edited. Added while the batch is open or in
--    progress, removed only while it is open (and never once a payment points at them: FK).
CREATE OR REPLACE FUNCTION batch_accounts_protect()
RETURNS trigger AS $$
DECLARE
  batch_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'batch_accounts rows are a snapshot and cannot be edited';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status INTO batch_status FROM collection_batches WHERE id = NEW.batch_id;
    IF batch_status NOT IN ('open', 'in_progress') THEN
      RAISE EXCEPTION 'accounts cannot be added to a % collection batch', batch_status;
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO batch_status FROM collection_batches WHERE id = OLD.batch_id;
  IF batch_status <> 'open' THEN
    RAISE EXCEPTION 'accounts can only be removed while the collection batch is open (it is %)', batch_status;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER batch_accounts_protect
BEFORE INSERT OR UPDATE OR DELETE ON batch_accounts
FOR EACH ROW EXECUTE FUNCTION batch_accounts_protect();
--> statement-breakpoint

-- 3. Remittances: recorded only after the collector submitted and before reconciliation.
--    Never deleted or edited; the only change is voiding, once, while still unreconciled.
CREATE OR REPLACE FUNCTION collector_remittances_protect()
RETURNS trigger AS $$
DECLARE
  batch_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a remittance cannot be deleted; void it instead';
  END IF;

  SELECT status INTO batch_status FROM collection_batches WHERE id = NEW.batch_id;
  IF batch_status NOT IN ('submitted', 'remitted') THEN
    RAISE EXCEPTION 'remittances cannot be recorded or voided on a % collection batch', batch_status;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this remittance is already voided';
  END IF;
  IF (NEW.batch_id, NEW.collector_id, NEW.amount_centavos, NEW.notes, NEW.received_by_user_id, NEW.received_at)
     IS DISTINCT FROM
     (OLD.batch_id, OLD.collector_id, OLD.amount_centavos, OLD.notes, OLD.received_by_user_id, OLD.received_at) THEN
    RAISE EXCEPTION 'a remittance cannot be edited; void it and record it again';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER collector_remittances_protect
BEFORE INSERT OR UPDATE OR DELETE ON collector_remittances
FOR EACH ROW EXECUTE FUNCTION collector_remittances_protect();
--> statement-breakpoint

-- 4. A field collection can only be recorded while its batch is in progress.
CREATE OR REPLACE FUNCTION payments_field_collection_in_progress()
RETURNS trigger AS $$
DECLARE
  batch_status text;
BEGIN
  SELECT status INTO batch_status FROM collection_batches WHERE id = NEW.collection_batch_id;
  IF batch_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'collections can only be recorded on an in-progress batch (it is %)', batch_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_field_collection_in_progress
BEFORE INSERT ON payments
FOR EACH ROW WHEN (NEW.collection_batch_id IS NOT NULL)
EXECUTE FUNCTION payments_field_collection_in_progress();
--> statement-breakpoint

-- 5. Same rule as 0015, now also freezing the batch and collector a payment came in through.
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
      NEW.reference_number, NEW.notes, NEW.gcash_submission_id, NEW.received_by_user_id, NEW.posted_at,
      NEW.collection_batch_id, NEW.collector_id)
     IS DISTINCT FROM
     (OLD.receipt_number, OLD.subscriber_id, OLD.method, OLD.amount_centavos, OLD.payment_date,
      OLD.reference_number, OLD.notes, OLD.gcash_submission_id, OLD.received_by_user_id, OLD.posted_at,
      OLD.collection_batch_id, OLD.collector_id) THEN
    RAISE EXCEPTION 'payment % is posted; correct it by reversal, not by editing', OLD.receipt_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
