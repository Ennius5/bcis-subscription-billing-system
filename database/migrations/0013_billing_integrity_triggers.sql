-- Billing rules the database itself enforces, so no code path (or direct SQL) can break them.

-- Invoice numbers start at INV-000001.
INSERT INTO document_sequences (name, prefix, next_value) VALUES ('invoice', 'INV-', 1)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- 1. The ledger is append-only, like audit_logs (0004) and service_events (0010).
CREATE OR REPLACE FUNCTION ledger_entries_block_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update_delete
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_entries_block_modification();
--> statement-breakpoint

-- 2. Finalized invoices are immutable (spec 3.4). After finalizing, only the payment
--    progress (paid_centavos, status) and the void fields may change; a void is final;
--    nothing goes back to draft; only drafts can be deleted.
CREATE OR REPLACE FUNCTION invoices_protect_finalized()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'invoice % is finalized and cannot be deleted; void it instead', OLD.invoice_number;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'invoice % is void and cannot change', OLD.invoice_number;
  END IF;

  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'invoice % is finalized and cannot return to draft', OLD.invoice_number;
  END IF;

  IF (NEW.invoice_number, NEW.billing_cycle_id, NEW.subscriber_id, NEW.service_account_id,
      NEW.period_start, NEW.period_end, NEW.invoice_date, NEW.due_date, NEW.total_centavos,
      NEW.created_by_user_id, NEW.created_at, NEW.finalized_by_user_id, NEW.finalized_at)
     IS DISTINCT FROM
     (OLD.invoice_number, OLD.billing_cycle_id, OLD.subscriber_id, OLD.service_account_id,
      OLD.period_start, OLD.period_end, OLD.invoice_date, OLD.due_date, OLD.total_centavos,
      OLD.created_by_user_id, OLD.created_at, OLD.finalized_by_user_id, OLD.finalized_at) THEN
    RAISE EXCEPTION 'invoice % is finalized; its billed details cannot change', OLD.invoice_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoices_protect_finalized
BEFORE UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION invoices_protect_finalized();
--> statement-breakpoint

-- 3. Invoice lines can only change while their invoice is a draft. When a draft invoice
--    is deleted, its lines go with it (ON DELETE CASCADE); by then the parent row is gone,
--    so a missing parent is allowed.
CREATE OR REPLACE FUNCTION invoice_items_protect_finalized()
RETURNS trigger AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO parent_status FROM invoices WHERE id = OLD.invoice_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'invoice lines of a finalized invoice cannot be changed (% not allowed)', TG_OP;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO parent_status FROM invoices WHERE id = NEW.invoice_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'invoice lines of a finalized invoice cannot be changed (% not allowed)', TG_OP;
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoice_items_protect_finalized
BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW EXECUTE FUNCTION invoice_items_protect_finalized();
