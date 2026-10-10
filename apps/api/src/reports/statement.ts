import { sql } from "drizzle-orm";
import {
  AGING_BUCKETS,
  type AgingBucket,
  type LedgerQuery,
  agingBucket,
  daysPastDue,
  periodLabel,
  periodOf,
} from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";
import { type SubscriberLedger, getSubscriberLedger } from "../billing/ledger";
import { dbToday } from "../db/query_helpers";
import { type SubscriberDetail, getSubscriber } from "../subscribers/service";
import type { Db } from "../db/client";

export interface StatementInvoice {
  invoiceId: string;
  invoiceNumber: string;
  serviceNumber: string;
  periodLabel: string;
  invoiceDate: string;
  dueDate: string;
  /** Total plus adjustments posted up to the statement date. */
  amountCentavos: number;
  /** Payments applied up to the statement date (reversals made by then taken out). */
  paidCentavos: number;
  openCentavos: number;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface StatementOfAccount {
  subscriber: {
    id: string;
    accountNumber: string;
    fullName: string;
    status: string;
    address: string | null;
    area: string | null;
  };
  /** The statement date: the end of the range, today when none was given. */
  asOf: string;
  ledger: SubscriberLedger;
  /** Invoices with a balance on the statement date, oldest due first. */
  openInvoices: StatementInvoice[];
  aging: Record<AgingBucket, number>;
  openInvoicesCentavos: number;
  /** Payment money not applied to any invoice on the statement date. */
  unappliedCreditCentavos: number;
  /**
   * open invoices - unapplied credit = ledger closing balance. Always true unless the data is
   * inconsistent; the statement says so instead of printing figures that disagree.
   */
  reconciles: boolean;
}

/** A date counts for an allocation on the day its money is in the ledger, or when credit was applied. */
const ALLOCATION_DATE = sql`CASE WHEN pa.source = 'credit' THEN (pa.allocated_at AT TIME ZONE 'Asia/Manila')::date ELSE p.payment_date END`;
const notReversedBy = (asOf: string) => sql`NOT EXISTS (
  SELECT 1 FROM ledger_entries r WHERE r.payment_id = p.id AND r.entry_type = 'payment_reversal' AND r.entry_date <= ${asOf})`;

/**
 * Each invoice's balance as it stood on `asOf`, rebuilt from dated records: the invoice (by
 * invoice date, unless voided by then), adjustments by ledger date, and allocations whose
 * payment had not been reversed by then. Nothing here reads today's invoice status.
 */
async function openInvoicesAsOf(db: DbOrTx, subscriberId: string, asOf: string): Promise<StatementInvoice[]> {
  const result = await db.execute<{
    id: string;
    invoice_number: string;
    service_number: string;
    period_start: string;
    invoice_date: string;
    due_date: string;
    total_centavos: number;
    adjusted: string;
    paid: string;
  }>(sql`
    SELECT i.id, i.invoice_number, sa.service_number, i.period_start::text, i.invoice_date::text, i.due_date::text,
           i.total_centavos,
           coalesce((
             SELECT sum(le.debit_centavos - le.credit_centavos)
             FROM ledger_entries le JOIN adjustments adj ON adj.id = le.adjustment_id
             WHERE adj.invoice_id = i.id AND le.entry_date <= ${asOf}
           ), 0)::bigint AS adjusted,
           coalesce((
             SELECT sum(pa.amount_centavos)
             FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
             WHERE pa.invoice_id = i.id AND ${ALLOCATION_DATE} <= ${asOf} AND ${notReversedBy(asOf)}
           ), 0)::bigint AS paid
    FROM invoices i
    JOIN service_accounts sa ON sa.id = i.service_account_id
    WHERE i.subscriber_id = ${subscriberId}
      AND i.status <> 'draft'
      AND i.invoice_date <= ${asOf}
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries v
        WHERE v.invoice_id = i.id AND v.entry_type = 'invoice_void' AND v.entry_date <= ${asOf})
    ORDER BY i.due_date, i.invoice_number
  `);
  return result.rows
    .map((r) => {
      const amountCentavos = r.total_centavos + Number(r.adjusted);
      const paidCentavos = Number(r.paid);
      return {
        invoiceId: r.id,
        invoiceNumber: r.invoice_number,
        serviceNumber: r.service_number,
        periodLabel: periodLabel(periodOf(r.period_start)),
        invoiceDate: r.invoice_date,
        dueDate: r.due_date,
        amountCentavos,
        paidCentavos,
        openCentavos: amountCentavos - paidCentavos,
        daysPastDue: Math.max(0, daysPastDue(r.due_date, asOf)),
        bucket: agingBucket(r.due_date, asOf),
      };
    })
    .filter((i) => i.openCentavos > 0);
}

/** Posted payment money not yet on an invoice on `asOf`. */
async function unappliedCreditAsOf(db: DbOrTx, subscriberId: string, asOf: string): Promise<number> {
  const result = await db.execute<{ received: string; applied: string }>(sql`
    SELECT
      coalesce((SELECT sum(p.amount_centavos) FROM payments p
                WHERE p.subscriber_id = ${subscriberId} AND p.payment_date <= ${asOf} AND ${notReversedBy(asOf)}), 0)::bigint AS received,
      coalesce((SELECT sum(pa.amount_centavos) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                WHERE p.subscriber_id = ${subscriberId} AND ${ALLOCATION_DATE} <= ${asOf} AND ${notReversedBy(asOf)}), 0)::bigint AS applied
  `);
  const row = result.rows[0];
  return Number(row?.received ?? 0) - Number(row?.applied ?? 0);
}

function primaryAddress(subscriber: SubscriberDetail): string | null {
  const a = subscriber.addresses.find((x) => x.isPrimary && x.isActive) ?? subscriber.addresses.find((x) => x.isActive);
  if (!a) return null;
  return [a.line1, a.barangay, a.city, a.province].filter(Boolean).join(", ");
}

/**
 * Statement of Account (spec 3.11): the ledger for the range with opening and closing
 * balances, and the invoices still unpaid on the statement date, aged as of that date.
 */
export async function getStatementOfAccount(db: Db, subscriberId: string, range: LedgerQuery): Promise<StatementOfAccount> {
  const subscriber = await getSubscriber(db, subscriberId);
  const asOf = range.to ?? (await dbToday(db));
  const ledger = await getSubscriberLedger(db, subscriberId, { ...range, to: asOf });
  const openInvoices = await openInvoicesAsOf(db, subscriberId, asOf);
  const unappliedCreditCentavos = await unappliedCreditAsOf(db, subscriberId, asOf);

  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const invoice of openInvoices) aging[invoice.bucket] += invoice.openCentavos;
  const openInvoicesCentavos = openInvoices.reduce((t, i) => t + i.openCentavos, 0);

  return {
    subscriber: {
      id: subscriber.id,
      accountNumber: subscriber.accountNumber,
      fullName: subscriber.fullName,
      status: subscriber.status,
      address: primaryAddress(subscriber),
      area: subscriber.areaCode ? `${subscriber.areaCode} ${subscriber.areaName ?? ""}`.trim() : null,
    },
    asOf,
    ledger,
    openInvoices,
    aging,
    openInvoicesCentavos,
    unappliedCreditCentavos,
    reconciles: openInvoicesCentavos - unappliedCreditCentavos === ledger.closingBalanceCentavos,
  };
}
