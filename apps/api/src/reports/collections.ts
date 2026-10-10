import { sql } from "drizzle-orm";
import {
  type CollectionsReportQuery,
  PAYMENT_METHODS,
  type PaymentMethod,
  type ReportGrouping,
  periodStartOf,
  reportPeriods,
} from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";

export interface CollectionAmounts {
  paymentCount: number;
  collectedCentavos: number;
  reversalCount: number;
  reversedCentavos: number;
  /** collected - reversed */
  netCentavos: number;
}

export interface CollectionsPeriodRow extends CollectionAmounts {
  start: string;
  end: string;
  label: string;
  netByMethod: Record<PaymentMethod, number>;
}

export interface CollectionsMethodRow extends CollectionAmounts {
  method: PaymentMethod;
}

export interface CollectionsReport {
  from: string;
  to: string;
  groupBy: ReportGrouping;
  periods: CollectionsPeriodRow[];
  /** Every method, in PAYMENT_METHODS order, even when nothing came in through it. */
  methods: CollectionsMethodRow[];
  totals: CollectionAmounts;
}

const zero = (): CollectionAmounts => ({
  paymentCount: 0,
  collectedCentavos: 0,
  reversalCount: 0,
  reversedCentavos: 0,
  netCentavos: 0,
});

const zeroByMethod = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

type DailyLine = {
  day: string;
  method: PaymentMethod;
  count: number;
  centavos: number;
};

/**
 * Collections over a date range (spec 3.11), by day, week, month or year, plus a summary by
 * payment method. A payment counts on its payment date; a reversal is subtracted on the date
 * of its ledger entry, so figures for past periods never change after the fact (like the
 * ledger). A payment that was later reversed therefore still shows in its own period.
 */
export async function getCollectionsReport(db: DbOrTx, query: CollectionsReportQuery): Promise<CollectionsReport> {
  const { from, to, groupBy } = query;

  const payments = await db.execute<DailyLine>(sql`
    SELECT payment_date::text AS day, method, count(*)::int AS count, sum(amount_centavos)::int AS centavos
    FROM payments
    WHERE payment_date BETWEEN ${from} AND ${to}
    GROUP BY payment_date, method
  `);
  const reversals = await db.execute<DailyLine>(sql`
    SELECT le.entry_date::text AS day, p.method, count(*)::int AS count, sum(le.debit_centavos)::int AS centavos
    FROM ledger_entries le
    JOIN payments p ON p.id = le.payment_id
    WHERE le.entry_type = 'payment_reversal' AND le.entry_date BETWEEN ${from} AND ${to}
    GROUP BY le.entry_date, p.method
  `);

  const periods: CollectionsPeriodRow[] = reportPeriods(from, to, groupBy).map((p) => ({
    ...p,
    ...zero(),
    netByMethod: zeroByMethod(),
  }));
  const byStart = new Map(periods.map((p) => [p.start, p]));
  const periodOf = (day: string) => {
    const start = periodStartOf(day, groupBy);
    const row = byStart.get(start < from ? from : start);
    if (!row) throw new Error(`No report period for ${day}`);
    return row;
  };

  const methods = new Map<PaymentMethod, CollectionsMethodRow>(PAYMENT_METHODS.map((m) => [m, { method: m, ...zero() }]));
  const totals = zero();
  const add = (target: CollectionAmounts, line: DailyLine, kind: "payment" | "reversal") => {
    if (kind === "payment") {
      target.paymentCount += line.count;
      target.collectedCentavos += line.centavos;
      target.netCentavos += line.centavos;
    } else {
      target.reversalCount += line.count;
      target.reversedCentavos += line.centavos;
      target.netCentavos -= line.centavos;
    }
  };

  for (const [lines, kind] of [
    [payments.rows, "payment"],
    [reversals.rows, "reversal"],
  ] as const) {
    for (const line of lines) {
      const period = periodOf(line.day);
      add(period, line, kind);
      period.netByMethod[line.method] += kind === "payment" ? line.centavos : -line.centavos;
      add(methods.get(line.method)!, line, kind);
      add(totals, line, kind);
    }
  }

  return { from, to, groupBy, periods, methods: [...methods.values()], totals };
}
