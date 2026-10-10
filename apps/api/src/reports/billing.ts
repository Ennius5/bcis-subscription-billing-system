import { type SQL, sql } from "drizzle-orm";
import {
  type BillingVsCollectionQuery,
  type RevenueDimension,
  type RevenueQuery,
  SERVICE_TYPE_LABELS,
  type ServiceTypeCode,
  collectionRateBasisPoints,
  monthsInRange,
  periodBounds,
  periodLabel,
} from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";
import { getCollectionsReport } from "./collections";

/*
 * Billed = finalized, non-void invoices, by billing month (period_start). Adjustments count in
 * the month they were posted (their ledger entry date), against the invoice they adjust.
 * Collected = the collections report (payments by payment date less reversals by their date).
 */
const BILLED = sql`i.status NOT IN ('draft', 'void')`;

const num = (value: string | number | null) => Number(value ?? 0);

/* ------------------------- Billing vs collection ------------------------- */

export interface BillingVsCollectionRow {
  month: string;
  label: string;
  invoiceCount: number;
  billedCentavos: number;
  adjustmentCount: number;
  /** Debit adjustments less credit adjustments posted this month. */
  adjustmentsCentavos: number;
  netBilledCentavos: number;
  collectedCentavos: number;
  /** collected / net billed, in basis points; null when nothing was billed. */
  collectionRateBasisPoints: number | null;
  /** net billed - collected (negative when more came in than was billed). */
  gapCentavos: number;
}

export interface BillingVsCollectionReport {
  from: string;
  to: string;
  months: BillingVsCollectionRow[];
  totals: Omit<BillingVsCollectionRow, "month" | "label">;
}

export async function getBillingVsCollection(
  db: DbOrTx,
  query: BillingVsCollectionQuery,
): Promise<BillingVsCollectionReport> {
  const start = periodBounds(query.from).start;
  const end = periodBounds(query.to).end;

  const billed = await db.execute<{ month: string; count: number; centavos: string }>(sql`
    SELECT to_char(i.period_start, 'YYYY-MM') AS month, count(*)::int AS count, sum(i.total_centavos)::bigint AS centavos
    FROM invoices i
    WHERE ${BILLED} AND i.period_start BETWEEN ${start} AND ${end}
    GROUP BY 1
  `);
  const adjusted = await db.execute<{ month: string; count: number; centavos: string }>(sql`
    SELECT to_char(entry_date, 'YYYY-MM') AS month, count(*)::int AS count,
           sum(debit_centavos - credit_centavos)::bigint AS centavos
    FROM ledger_entries
    WHERE entry_type = 'adjustment' AND entry_date BETWEEN ${start} AND ${end}
    GROUP BY 1
  `);
  const collections = await getCollectionsReport(db, { from: start, to: end, groupBy: "month" });

  const billedBy = new Map(billed.rows.map((r) => [r.month, r]));
  const adjustedBy = new Map(adjusted.rows.map((r) => [r.month, r]));
  const collectedBy = new Map(collections.periods.map((p) => [p.start.slice(0, 7), p.netCentavos]));

  const months = monthsInRange(query.from, query.to).map((month): BillingVsCollectionRow => {
    const billedCentavos = num(billedBy.get(month)?.centavos ?? 0);
    const adjustmentsCentavos = num(adjustedBy.get(month)?.centavos ?? 0);
    const netBilledCentavos = billedCentavos + adjustmentsCentavos;
    const collectedCentavos = collectedBy.get(month) ?? 0;
    return {
      month,
      label: periodLabel(month),
      invoiceCount: billedBy.get(month)?.count ?? 0,
      billedCentavos,
      adjustmentCount: adjustedBy.get(month)?.count ?? 0,
      adjustmentsCentavos,
      netBilledCentavos,
      collectedCentavos,
      collectionRateBasisPoints: collectionRateBasisPoints(collectedCentavos, netBilledCentavos),
      gapCentavos: netBilledCentavos - collectedCentavos,
    };
  });

  const sum = (pick: (r: BillingVsCollectionRow) => number) => months.reduce((t, r) => t + pick(r), 0);
  const netBilledCentavos = sum((r) => r.netBilledCentavos);
  const collectedCentavos = sum((r) => r.collectedCentavos);
  return {
    from: query.from,
    to: query.to,
    months,
    totals: {
      invoiceCount: sum((r) => r.invoiceCount),
      billedCentavos: sum((r) => r.billedCentavos),
      adjustmentCount: sum((r) => r.adjustmentCount),
      adjustmentsCentavos: sum((r) => r.adjustmentsCentavos),
      netBilledCentavos,
      collectedCentavos,
      collectionRateBasisPoints: collectionRateBasisPoints(collectedCentavos, netBilledCentavos),
      gapCentavos: netBilledCentavos - collectedCentavos,
    },
  };
}

/* -------------------------------- Revenue -------------------------------- */

export interface RevenueAmounts {
  invoiceCount: number;
  subscriptionCentavos: number;
  installationCentavos: number;
  reconnectionCentavos: number;
  /** Invoice lines of any other type. */
  otherCentavos: number;
  billedCentavos: number;
  adjustmentsCentavos: number;
  netCentavos: number;
}

export interface RevenueRow extends RevenueAmounts {
  key: string;
  label: string;
  /** Share of total net revenue, basis points; null when the total is not positive. */
  shareBasisPoints: number | null;
}

export interface RevenueReport {
  from: string;
  to: string;
  dimension: RevenueDimension;
  rows: RevenueRow[];
  totals: RevenueAmounts;
}

/**
 * The grouping key and label for each invoice. The plan is the one snapshotted on the
 * invoice's subscription line (falling back to the account's plan), so a later plan change
 * does not move past revenue. The area is the subscriber's current area (there is no area
 * history), which the report states.
 */
const DIMENSION_KEY: Record<RevenueDimension, { key: SQL; label: SQL }> = {
  plan: { key: sql`p.id::text`, label: sql`p.code || ' ' || p.name` },
  service_type: { key: sql`st.code`, label: sql`st.code` },
  area: { key: sql`coalesce(a.id::text, 'none')`, label: sql`coalesce(a.code || ' ' || a.name, 'No area')` },
};

function invoiceDimensions(dimension: RevenueDimension): SQL {
  const { key, label } = DIMENSION_KEY[dimension];
  return sql`
    SELECT i.id, i.period_start, ${key} AS key, ${label} AS label
    FROM invoices i
    JOIN service_accounts sa ON sa.id = i.service_account_id
    JOIN subscribers s ON s.id = i.subscriber_id
    JOIN service_plans p ON p.id = coalesce(
      (SELECT ii.plan_id FROM invoice_items ii
       WHERE ii.invoice_id = i.id AND ii.plan_id IS NOT NULL ORDER BY ii.line_no LIMIT 1),
      sa.plan_id)
    JOIN service_types st ON st.id = p.service_type_id
    LEFT JOIN collection_areas a ON a.id = s.collection_area_id
    WHERE ${BILLED}
  `;
}

const ITEM_FIELD: Record<string, "subscriptionCentavos" | "installationCentavos" | "reconnectionCentavos"> = {
  subscription: "subscriptionCentavos",
  installation_fee: "installationCentavos",
  reconnection_fee: "reconnectionCentavos",
};

const zeroRevenue = (): RevenueAmounts => ({
  invoiceCount: 0,
  subscriptionCentavos: 0,
  installationCentavos: 0,
  reconnectionCentavos: 0,
  otherCentavos: 0,
  billedCentavos: 0,
  adjustmentsCentavos: 0,
  netCentavos: 0,
});

/** Billed revenue by plan, service type or area over billing months, split by invoice line type. */
export async function getRevenueReport(db: DbOrTx, query: RevenueQuery): Promise<RevenueReport> {
  const start = periodBounds(query.from).start;
  const end = periodBounds(query.to).end;
  const dims = invoiceDimensions(query.dimension);

  const counts = await db.execute<{ key: string; label: string; count: number }>(sql`
    WITH d AS (${dims})
    SELECT key, label, count(*)::int AS count FROM d WHERE period_start BETWEEN ${start} AND ${end} GROUP BY key, label
  `);
  const items = await db.execute<{ key: string; item_type: string; centavos: string }>(sql`
    WITH d AS (${dims})
    SELECT d.key, ii.item_type, sum(ii.amount_centavos)::bigint AS centavos
    FROM d JOIN invoice_items ii ON ii.invoice_id = d.id
    WHERE d.period_start BETWEEN ${start} AND ${end}
    GROUP BY d.key, ii.item_type
  `);
  const adjustments = await db.execute<{ key: string; label: string; centavos: string }>(sql`
    WITH d AS (${dims})
    SELECT d.key, d.label, sum(le.debit_centavos - le.credit_centavos)::bigint AS centavos
    FROM ledger_entries le
    JOIN adjustments adj ON adj.id = le.adjustment_id
    JOIN d ON d.id = adj.invoice_id
    WHERE le.entry_type = 'adjustment' AND le.entry_date BETWEEN ${start} AND ${end}
    GROUP BY d.key, d.label
  `);

  const label = (raw: string) =>
    query.dimension === "service_type" ? (SERVICE_TYPE_LABELS[raw as ServiceTypeCode] ?? raw) : raw;
  const rows = new Map<string, RevenueAmounts & { key: string; label: string }>();
  const rowFor = (key: string, rawLabel: string) => {
    let row = rows.get(key);
    if (!row) {
      row = { key, label: label(rawLabel), ...zeroRevenue() };
      rows.set(key, row);
    }
    return row;
  };

  for (const c of counts.rows) rowFor(c.key, c.label).invoiceCount = c.count;
  for (const item of items.rows) {
    const row = rows.get(item.key);
    if (!row) continue; // every item belongs to a counted invoice
    const amount = num(item.centavos);
    row[ITEM_FIELD[item.item_type] ?? "otherCentavos"] += amount;
    row.billedCentavos += amount;
    row.netCentavos += amount;
  }
  // An adjustment in range may belong to an invoice of an earlier month, hence its own row.
  for (const a of adjustments.rows) {
    const row = rowFor(a.key, a.label);
    row.adjustmentsCentavos += num(a.centavos);
    row.netCentavos += num(a.centavos);
  }

  const totals = zeroRevenue();
  for (const row of rows.values()) {
    for (const field of Object.keys(totals) as (keyof RevenueAmounts)[]) totals[field] += row[field];
  }
  return {
    from: query.from,
    to: query.to,
    dimension: query.dimension,
    rows: [...rows.values()]
      .map((r) => ({
        ...r,
        shareBasisPoints: totals.netCentavos > 0 ? Math.round((r.netCentavos * 10_000) / totals.netCentavos) : null,
      }))
      .toSorted((a, b) => b.netCentavos - a.netCentavos || a.label.localeCompare(b.label)),
    totals,
  };
}
