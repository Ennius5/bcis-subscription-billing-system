import { sql } from "drizzle-orm";
import type { LedgerQuery } from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";

export interface LedgerEntryRow {
  id: string;
  seq: number;
  entryDate: string;
  entryType: string;
  reference: string;
  description: string;
  serviceAccountId: string | null;
  invoiceId: string | null;
  debitCentavos: number;
  creditCentavos: number;
  /** Running balance after this entry: positive means the subscriber owes. */
  balanceCentavos: number;
}

export interface SubscriberLedger {
  subscriberId: string;
  from: string | null;
  to: string | null;
  /** Balance carried in from before `from` (0 when there is no start date). */
  openingBalanceCentavos: number;
  entries: LedgerEntryRow[];
  closingBalanceCentavos: number;
  totalDebitCentavos: number;
  totalCreditCentavos: number;
}

/** What the subscriber owes now: debits minus credits. Negative is a credit in their favour. */
export async function getSubscriberBalance(executor: DbOrTx, subscriberId: string): Promise<number> {
  const result = await executor.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(debit_centavos - credit_centavos), 0)::bigint AS balance
    FROM ledger_entries WHERE subscriber_id = ${subscriberId}
  `);
  return Number(result.rows[0]?.balance ?? 0);
}

/**
 * The subscriber ledger (spec 3.5) with a running balance computed from the entries in
 * posting order (entry_date, then seq). Nothing is stored, so the balance is always
 * reproducible from the entries themselves. A date range gives an opening balance, which
 * is what the Statement of Account needs.
 */
export async function getSubscriberLedger(
  executor: DbOrTx,
  subscriberId: string,
  range: LedgerQuery = {},
): Promise<SubscriberLedger> {
  const from = range.from ?? null;
  const to = range.to ?? null;

  const opening = from
    ? Number(
        (
          await executor.execute<{ balance: string }>(sql`
            SELECT coalesce(sum(debit_centavos - credit_centavos), 0)::bigint AS balance
            FROM ledger_entries WHERE subscriber_id = ${subscriberId} AND entry_date < ${from}
          `)
        ).rows[0]?.balance ?? 0,
      )
    : 0;

  const result = await executor.execute<{
    id: string;
    seq: string;
    entry_date: string;
    entry_type: string;
    reference: string;
    description: string;
    service_account_id: string | null;
    invoice_id: string | null;
    debit_centavos: number;
    credit_centavos: number;
    running: string;
  }>(sql`
    SELECT id, seq, entry_date::text AS entry_date, entry_type, reference, description,
           service_account_id, invoice_id, debit_centavos, credit_centavos,
           sum(debit_centavos - credit_centavos) OVER (ORDER BY entry_date, seq ROWS UNBOUNDED PRECEDING)::bigint AS running
    FROM ledger_entries
    WHERE subscriber_id = ${subscriberId}
      ${from ? sql`AND entry_date >= ${from}` : sql``}
      ${to ? sql`AND entry_date <= ${to}` : sql``}
    ORDER BY entry_date, seq
  `);

  let totalDebit = 0;
  let totalCredit = 0;
  const entries = result.rows.map((r) => {
    totalDebit += r.debit_centavos;
    totalCredit += r.credit_centavos;
    return {
      id: r.id,
      seq: Number(r.seq),
      entryDate: r.entry_date,
      entryType: r.entry_type,
      reference: r.reference,
      description: r.description,
      serviceAccountId: r.service_account_id,
      invoiceId: r.invoice_id,
      debitCentavos: r.debit_centavos,
      creditCentavos: r.credit_centavos,
      balanceCentavos: opening + Number(r.running),
    };
  });

  return {
    subscriberId,
    from,
    to,
    openingBalanceCentavos: opening,
    entries,
    closingBalanceCentavos: opening + totalDebit - totalCredit,
    totalDebitCentavos: totalDebit,
    totalCreditCentavos: totalCredit,
  };
}
