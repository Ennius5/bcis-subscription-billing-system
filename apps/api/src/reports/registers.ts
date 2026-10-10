import { sql } from "drizzle-orm";
import {
  type ExceptionsQuery,
  type MasterListFilter,
  SUBSCRIBER_STATUSES,
  type SubscriberStatus,
} from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";
import { dbToday } from "../db/query_helpers";

/* -------------------------- Subscriber master list -------------------------- */

export interface MasterListRow {
  subscriberId: string;
  accountNumber: string;
  fullName: string;
  status: SubscriberStatus;
  area: string | null;
  collector: string | null;
  address: string | null;
  contact: string | null;
  activeServiceCount: number;
  /** Plan codes of live (pending, active, suspended) services. */
  plans: string | null;
  /** Sum of the current rates of active services. */
  monthlyRateCentavos: number;
  /** Ledger balance now: positive owes, negative is credit. */
  balanceCentavos: number;
}

export interface MasterList {
  asOf: string;
  /** One page for the screen, or every match for an export. */
  rows: MasterListRow[];
  /** Matching subscribers; statusCounts and totals cover all of them, not just the page. */
  total: number;
  page: number;
  pageSize: number;
  statusCounts: Record<SubscriberStatus, number>;
  totals: { subscriberCount: number; activeServiceCount: number; monthlyRateCentavos: number; balanceCentavos: number };
}

/** One row per matching subscriber with the computed columns; paged or aggregated by the callers. */
function masterListRows(filter: MasterListFilter) {
  return sql`
    SELECT s.id, s.account_number, s.full_name, s.status,
      a.code || ' ' || a.name AS area,
      c.code || ' ' || c.full_name AS collector,
      (SELECT concat_ws(', ', ad.line1, ad.barangay, ad.city) FROM subscriber_addresses ad
       WHERE ad.subscriber_id = s.id AND ad.is_active ORDER BY ad.is_primary DESC, ad.id LIMIT 1) AS address,
      (SELECT ct.value FROM subscriber_contacts ct
       WHERE ct.subscriber_id = s.id AND ct.is_active ORDER BY ct.is_primary DESC, ct.id LIMIT 1) AS contact,
      (SELECT count(*) FROM service_accounts sa WHERE sa.subscriber_id = s.id AND sa.status = 'active')::int AS active_services,
      (SELECT string_agg(DISTINCT p.code, ', ') FROM service_accounts sa JOIN service_plans p ON p.id = sa.plan_id
       WHERE sa.subscriber_id = s.id AND sa.status IN ('pending', 'active', 'suspended')) AS plans,
      (SELECT coalesce(sum(sa.current_rate_centavos), 0) FROM service_accounts sa
       WHERE sa.subscriber_id = s.id AND sa.status = 'active')::bigint AS monthly,
      (SELECT coalesce(sum(le.debit_centavos - le.credit_centavos), 0) FROM ledger_entries le
       WHERE le.subscriber_id = s.id)::bigint AS balance
    FROM subscribers s
    LEFT JOIN collection_areas a ON a.id = s.collection_area_id
    LEFT JOIN collectors c ON c.id = s.assigned_collector_id
    WHERE ${filter.status ? sql`s.status = ${filter.status}` : sql`s.status <> 'archived'`}
      ${filter.areaId ? sql`AND s.collection_area_id = ${filter.areaId}` : sql``}
      ${filter.collectorId ? sql`AND s.assigned_collector_id = ${filter.collectorId}` : sql``}
  `;
}

/**
 * Every subscriber with area, collector, primary address and contact, live services, monthly
 * rate and current balance (spec 3.11). Archived subscribers only when asked for by status.
 * With `paging` it returns one page (the screen); without, every matching row (the export).
 */
export async function getMasterList(
  db: DbOrTx,
  filter: MasterListFilter,
  paging?: { page: number; pageSize: number },
): Promise<MasterList> {
  const result = await db.execute<{
    id: string;
    account_number: string;
    full_name: string;
    status: SubscriberStatus;
    area: string | null;
    collector: string | null;
    address: string | null;
    contact: string | null;
    active_services: number;
    plans: string | null;
    monthly: string;
    balance: string;
  }>(sql`
    WITH m AS (${masterListRows(filter)})
    SELECT * FROM m ORDER BY account_number
    ${paging ? sql`LIMIT ${paging.pageSize} OFFSET ${(paging.page - 1) * paging.pageSize}` : sql``}
  `);
  const summary = await db.execute<{
    total: number;
    active: number;
    inactive: number;
    terminated: number;
    archived: number;
    active_services: string;
    monthly: string;
    balance: string;
  }>(sql`
    WITH m AS (${masterListRows(filter)})
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'active')::int AS active,
           count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
           count(*) FILTER (WHERE status = 'terminated')::int AS terminated,
           count(*) FILTER (WHERE status = 'archived')::int AS archived,
           coalesce(sum(active_services), 0)::bigint AS active_services,
           coalesce(sum(monthly), 0)::bigint AS monthly,
           coalesce(sum(balance), 0)::bigint AS balance
    FROM m
  `);
  const sums = summary.rows[0]!;

  const rows = result.rows.map(
    (r): MasterListRow => ({
      subscriberId: r.id,
      accountNumber: r.account_number,
      fullName: r.full_name,
      status: r.status,
      area: r.area,
      collector: r.collector,
      address: r.address,
      contact: r.contact,
      activeServiceCount: r.active_services,
      plans: r.plans,
      monthlyRateCentavos: Number(r.monthly),
      balanceCentavos: Number(r.balance),
    }),
  );
  return {
    asOf: await dbToday(db),
    rows,
    total: sums.total,
    page: paging?.page ?? 1,
    pageSize: paging?.pageSize ?? sums.total,
    statusCounts: Object.fromEntries(SUBSCRIBER_STATUSES.map((st) => [st, sums[st]])) as Record<SubscriberStatus, number>,
    totals: {
      subscriberCount: sums.total,
      activeServiceCount: Number(sums.active_services),
      monthlyRateCentavos: Number(sums.monthly),
      balanceCentavos: Number(sums.balance),
    },
  };
}

/* --------------------------- Exceptions register --------------------------- */

export interface AdjustmentLine {
  adjustmentNumber: string;
  date: string;
  invoiceNumber: string;
  accountNumber: string;
  subscriberName: string;
  kind: string;
  category: string;
  /** Signed: debits positive, credits negative. */
  amountCentavos: number;
  reason: string;
  by: string;
}

export interface ReversalLine {
  receiptNumber: string;
  paymentDate: string;
  reversedOn: string;
  accountNumber: string;
  subscriberName: string;
  method: string;
  amountCentavos: number;
  reason: string;
  by: string;
}

export interface VoidLine {
  invoiceNumber: string;
  period: string;
  voidedOn: string;
  accountNumber: string;
  subscriberName: string;
  amountCentavos: number;
  reason: string;
  by: string;
}

export interface ExceptionsRegister {
  from: string;
  to: string;
  adjustments: AdjustmentLine[];
  reversals: ReversalLine[];
  voids: VoidLine[];
  totals: {
    debitAdjustmentsCentavos: number;
    creditAdjustmentsCentavos: number;
    reversedCentavos: number;
    voidedCentavos: number;
  };
}

/**
 * Every change made to posted money between two dates, dated the day it was made (its ledger
 * date): adjustments, reversed receipts (the receipt number stays, shown VOID) and voided
 * invoices. Each line names who did it and why. An auditor's review list (spec 3.11, 4.4).
 */
export async function getExceptionsRegister(db: DbOrTx, query: ExceptionsQuery): Promise<ExceptionsRegister> {
  const { from, to } = query;

  const adjustments = await db.execute<{
    adjustment_number: string;
    date: string;
    invoice_number: string;
    account_number: string;
    full_name: string;
    kind: string;
    category: string;
    amount_centavos: number;
    reason: string;
    by: string;
  }>(sql`
    SELECT adj.adjustment_number, le.entry_date::text AS date, i.invoice_number, s.account_number, s.full_name,
           adj.kind, adj.category, adj.amount_centavos, adj.reason, u.full_name AS by
    FROM adjustments adj
    JOIN ledger_entries le ON le.adjustment_id = adj.id
    JOIN invoices i ON i.id = adj.invoice_id
    JOIN subscribers s ON s.id = adj.subscriber_id
    JOIN users u ON u.id = adj.created_by_user_id
    WHERE le.entry_date BETWEEN ${from} AND ${to}
    ORDER BY le.entry_date, adj.adjustment_number
  `);

  const reversals = await db.execute<{
    receipt_number: string;
    payment_date: string;
    reversed_on: string;
    account_number: string;
    full_name: string;
    method: string;
    amount_centavos: number;
    reason: string;
    by: string;
  }>(sql`
    SELECT p.receipt_number, p.payment_date::text, le.entry_date::text AS reversed_on, s.account_number, s.full_name,
           p.method, p.amount_centavos, pr.reason, u.full_name AS by
    FROM payment_reversals pr
    JOIN payments p ON p.id = pr.payment_id
    JOIN ledger_entries le ON le.payment_id = p.id AND le.entry_type = 'payment_reversal'
    JOIN subscribers s ON s.id = p.subscriber_id
    JOIN users u ON u.id = pr.reversed_by_user_id
    WHERE le.entry_date BETWEEN ${from} AND ${to}
    ORDER BY le.entry_date, p.receipt_number
  `);

  // A zero-total invoice has no void ledger entry; its void time (Manila date) stands in.
  const voids = await db.execute<{
    invoice_number: string;
    period: string;
    voided_on: string;
    account_number: string;
    full_name: string;
    total_centavos: number;
    void_reason: string;
    by: string;
  }>(sql`
    SELECT i.invoice_number, to_char(i.period_start, 'YYYY-MM') AS period,
           coalesce(v.entry_date, (i.voided_at AT TIME ZONE 'Asia/Manila')::date)::text AS voided_on,
           s.account_number, s.full_name, i.total_centavos, i.void_reason, u.full_name AS by
    FROM invoices i
    LEFT JOIN ledger_entries v ON v.invoice_id = i.id AND v.entry_type = 'invoice_void'
    JOIN subscribers s ON s.id = i.subscriber_id
    JOIN users u ON u.id = i.voided_by_user_id
    WHERE i.status = 'void'
      AND coalesce(v.entry_date, (i.voided_at AT TIME ZONE 'Asia/Manila')::date) BETWEEN ${from} AND ${to}
    ORDER BY 3, i.invoice_number
  `);

  const adjustmentLines = adjustments.rows.map(
    (r): AdjustmentLine => ({
      adjustmentNumber: r.adjustment_number,
      date: r.date,
      invoiceNumber: r.invoice_number,
      accountNumber: r.account_number,
      subscriberName: r.full_name,
      kind: r.kind,
      category: r.category,
      amountCentavos: r.kind === "credit" ? -r.amount_centavos : r.amount_centavos,
      reason: r.reason,
      by: r.by,
    }),
  );
  const reversalLines = reversals.rows.map(
    (r): ReversalLine => ({
      receiptNumber: r.receipt_number,
      paymentDate: r.payment_date,
      reversedOn: r.reversed_on,
      accountNumber: r.account_number,
      subscriberName: r.full_name,
      method: r.method,
      amountCentavos: r.amount_centavos,
      reason: r.reason,
      by: r.by,
    }),
  );
  const voidLines = voids.rows.map(
    (r): VoidLine => ({
      invoiceNumber: r.invoice_number,
      period: r.period,
      voidedOn: r.voided_on,
      accountNumber: r.account_number,
      subscriberName: r.full_name,
      amountCentavos: r.total_centavos,
      reason: r.void_reason,
      by: r.by,
    }),
  );

  return {
    from,
    to,
    adjustments: adjustmentLines,
    reversals: reversalLines,
    voids: voidLines,
    totals: {
      debitAdjustmentsCentavos: adjustmentLines.filter((a) => a.amountCentavos > 0).reduce((t, a) => t + a.amountCentavos, 0),
      creditAdjustmentsCentavos: -adjustmentLines.filter((a) => a.amountCentavos < 0).reduce((t, a) => t + a.amountCentavos, 0),
      reversedCentavos: reversalLines.reduce((t, r) => t + r.amountCentavos, 0),
      voidedCentavos: voidLines.reduce((t, v) => t + v.amountCentavos, 0),
    },
  };
}
