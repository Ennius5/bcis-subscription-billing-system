import { sql } from "drizzle-orm";
import { collectionRateBasisPoints, type CollectionBatchStatus, type CollectorReportQuery, type VarianceKind } from "@bcis/shared";
import type { Db } from "../db/client";

/** One batch line under a collector. Amounts come from posted payments and non-void remittances. */
export interface CollectorReportBatch {
  id: string;
  batchNumber: string;
  collectionDate: string;
  status: CollectionBatchStatus;
  accountCount: number;
  expectedTotalDueCentavos: number;
  cashCollectedCentavos: number;
  chequeCollectedCentavos: number;
  remittedCentavos: number;
  /** The frozen reconciliation difference; null until the batch is reconciled. */
  differenceCentavos: number | null;
  varianceKind: VarianceKind | null;
}

export interface CollectorReportTotals {
  batchCount: number;
  /** Submitted or remitted: the collector is back but the cash is not reconciled yet. */
  unreconciledCount: number;
  accountCount: number;
  expectedTotalDueCentavos: number;
  cashCollectedCentavos: number;
  chequeCollectedCentavos: number;
  remittedCentavos: number;
  /** From reconciled and closed batches only, as positive amounts. */
  shortageCentavos: number;
  overageCentavos: number;
  /** (cash + cheques) / total due, in basis points; null when nothing was due. */
  collectionRateBasisPoints: number | null;
}

export interface CollectorReportRow extends CollectorReportTotals {
  collectorId: string;
  code: string;
  fullName: string;
  isActive: boolean;
  batches: CollectorReportBatch[];
}

export interface CollectorReport {
  from: string;
  to: string;
  collectors: CollectorReportRow[];
  totals: CollectorReportTotals;
}

function summarize(batches: readonly CollectorReportBatch[]): CollectorReportTotals {
  const sum = (pick: (b: CollectorReportBatch) => number) => batches.reduce((t, b) => t + pick(b), 0);
  const expected = sum((b) => b.expectedTotalDueCentavos);
  const collected = sum((b) => b.cashCollectedCentavos + b.chequeCollectedCentavos);
  return {
    batchCount: batches.length,
    unreconciledCount: batches.filter((b) => b.status === "submitted" || b.status === "remitted").length,
    accountCount: sum((b) => b.accountCount),
    expectedTotalDueCentavos: expected,
    cashCollectedCentavos: sum((b) => b.cashCollectedCentavos),
    chequeCollectedCentavos: sum((b) => b.chequeCollectedCentavos),
    remittedCentavos: sum((b) => b.remittedCentavos),
    shortageCentavos: sum((b) => (b.varianceKind === "shortage" ? -b.differenceCentavos! : 0)),
    overageCentavos: sum((b) => (b.varianceKind === "overage" ? b.differenceCentavos! : 0)),
    collectionRateBasisPoints: collectionRateBasisPoints(collected, expected),
  };
}

/**
 * Collector report (spec 3.10: collection, remittance, shortage/overage and performance):
 * for each collector, the batches whose collection date falls in the range. Cancelled
 * batches are left out. What a subscriber paid elsewhere (office, GCash) is not the
 * collector's, so it does not count here. Active collectors with no batches are listed
 * with zeros, so a collector who did nothing shows up.
 */
export async function getCollectorReport(db: Db, query: CollectorReportQuery): Promise<CollectorReport> {
  const result = await db.execute<{
    id: string;
    batch_number: string;
    collector_id: string;
    collection_date: string;
    status: CollectionBatchStatus;
    account_count: string;
    expected: string;
    cash: string;
    cheque: string;
    remitted: string;
    difference_centavos: number | null;
    variance_kind: VarianceKind | null;
  }>(sql`
    WITH b AS (
      SELECT * FROM collection_batches
      WHERE collection_date BETWEEN ${query.from} AND ${query.to} AND status <> 'cancelled'
    ),
    acc AS (
      SELECT batch_id, count(*) AS n, sum(total_due_centavos) AS due
      FROM batch_accounts WHERE batch_id IN (SELECT id FROM b) GROUP BY batch_id
    ),
    pay AS (
      SELECT collection_batch_id AS batch_id,
        coalesce(sum(amount_centavos) FILTER (WHERE method = 'cash'), 0) AS cash,
        coalesce(sum(amount_centavos) FILTER (WHERE method = 'cheque'), 0) AS cheque
      FROM payments WHERE status = 'posted' AND collection_batch_id IN (SELECT id FROM b) GROUP BY collection_batch_id
    ),
    rem AS (
      SELECT batch_id, sum(amount_centavos) AS remitted
      FROM collector_remittances WHERE voided_at IS NULL AND batch_id IN (SELECT id FROM b) GROUP BY batch_id
    )
    SELECT b.id, b.batch_number, b.collector_id, b.collection_date::text AS collection_date, b.status,
      coalesce(acc.n, 0) AS account_count, coalesce(acc.due, 0) AS expected,
      coalesce(pay.cash, 0) AS cash, coalesce(pay.cheque, 0) AS cheque, coalesce(rem.remitted, 0) AS remitted,
      b.difference_centavos, b.variance_kind
    FROM b
    LEFT JOIN acc ON acc.batch_id = b.id
    LEFT JOIN pay ON pay.batch_id = b.id
    LEFT JOIN rem ON rem.batch_id = b.id
    ORDER BY b.collection_date, b.batch_number
  `);

  // Sums come back as text (bigint); amounts here are far below Number.MAX_SAFE_INTEGER.
  const batchesByCollector = new Map<string, CollectorReportBatch[]>();
  for (const r of result.rows) {
    const line: CollectorReportBatch = {
      id: r.id,
      batchNumber: r.batch_number,
      collectionDate: r.collection_date,
      status: r.status,
      accountCount: Number(r.account_count),
      expectedTotalDueCentavos: Number(r.expected),
      cashCollectedCentavos: Number(r.cash),
      chequeCollectedCentavos: Number(r.cheque),
      remittedCentavos: Number(r.remitted),
      differenceCentavos: r.difference_centavos,
      varianceKind: r.variance_kind,
    };
    batchesByCollector.set(r.collector_id, [...(batchesByCollector.get(r.collector_id) ?? []), line]);
  }

  const collectors = await db.execute<{ id: string; code: string; full_name: string; is_active: boolean }>(sql`
    SELECT id, code, full_name, is_active FROM collectors ORDER BY code
  `);
  const rows = collectors.rows
    .filter((c) => c.is_active || batchesByCollector.has(c.id))
    .map((c) => {
      const batches = batchesByCollector.get(c.id) ?? [];
      return { collectorId: c.id, code: c.code, fullName: c.full_name, isActive: c.is_active, ...summarize(batches), batches };
    });

  return { from: query.from, to: query.to, collectors: rows, totals: summarize([...batchesByCollector.values()].flat()) };
}
