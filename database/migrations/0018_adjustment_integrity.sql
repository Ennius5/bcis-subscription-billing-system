-- Adjustment numbers start at ADJ-000001 and share the gapless counter used for invoices and receipts.
INSERT INTO document_sequences (name, prefix, next_value) VALUES ('adjustment', 'ADJ-', 1)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- Adjustments are posted financial records: never edited or deleted (block_modification is from 0015).
-- A wrong one is corrected by posting the opposite adjustment.
CREATE TRIGGER adjustments_no_update_delete
BEFORE UPDATE OR DELETE ON adjustments
FOR EACH ROW EXECUTE FUNCTION block_modification();
