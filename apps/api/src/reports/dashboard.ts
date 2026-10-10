import {
  type AgingBucket,
  type PaymentMethod,
  addMonths,
  agingQuerySchema,
  billingVsCollectionQuerySchema,
  collectionsReportQuerySchema,
  collectorReportQuerySchema,
  paymentListQuerySchema,
  periodOf,
  receivableListQuerySchema,
  suspensionCandidateQuerySchema,
} from "@bcis/shared";
import { getCollectorReport } from "../collection/report";
import type { Db } from "../db/client";
import { dbToday } from "../db/query_helpers";
import { listPayments } from "../payments/service";
import { getAgingReport, listReceivables, listSuspensionCandidates } from "../receivables/service";
import { getBillingVsCollection } from "./billing";
import { getCollectionsReport } from "./collections";

export interface DashboardKpis {
  /** Net billed this billing month (invoices + adjustments posted this month). */
  billedThisMonthCentavos: number;
  /** Payments this month so far, less reversals. */
  collectedThisMonthCentavos: number;
  collectionRateBasisPoints: number | null;
  /** Open invoice balances now. */
  receivableCentavos: number;
  overdueCentavos: number;
  overdueSubscriberCount: number;
  suspensionCandidateCount: number;
}

export interface Dashboard {
  asOf: string;
  month: string;
  kpis: DashboardKpis;
  /** The last six billing months, oldest first. */
  billingVsCollection: Array<{
    month: string;
    label: string;
    netBilledCentavos: number;
    collectedCentavos: number;
    collectionRateBasisPoints: number | null;
  }>;
  /** This month so far, every method (zero when unused). */
  paymentMethods: Array<{ method: PaymentMethod; paymentCount: number; netCentavos: number }>;
  aging: Array<{ bucket: AgingBucket; amountCentavos: number; accountCount: number }>;
  /** Collection batches dated this month so far. */
  collectors: Array<{
    collectorId: string;
    code: string;
    fullName: string;
    batchCount: number;
    expectedTotalDueCentavos: number;
    collectedCentavos: number;
    shortageCentavos: number;
    collectionRateBasisPoints: number | null;
  }>;
  oldestOverdue: Array<{
    subscriberId: string;
    accountNumber: string;
    subscriberName: string;
    serviceAccountId: string;
    serviceNumber: string;
    planCode: string;
    monthsUnpaid: number;
    oldestDueDate: string;
    daysPastDue: number;
    arrearsCentavos: number;
  }>;
  latestPayments: Array<{
    id: string;
    receiptNumber: string;
    status: string;
    paymentDate: string;
    postedAt: Date;
    method: string;
    amountCentavos: number;
    subscriberId: string;
    accountNumber: string;
    subscriberName: string;
  }>;
}

/**
 * The dashboard (spec 4.3), live as of today. Everything comes from the same services as the
 * reports and receivables screens, so a dashboard figure always matches its report.
 */
export async function getDashboard(db: Db): Promise<Dashboard> {
  const today = await dbToday(db);
  const month = periodOf(today);
  const monthStart = `${month}-01`;

  const [trend, collections, aging, candidates, collectorReport, overdue, payments] = await Promise.all([
    getBillingVsCollection(db, billingVsCollectionQuerySchema.parse({ from: addMonths(month, -5), to: month })),
    getCollectionsReport(db, collectionsReportQuerySchema.parse({ from: monthStart, to: today, groupBy: "month" })),
    getAgingReport(db, agingQuerySchema.parse({})),
    listSuspensionCandidates(db, suspensionCandidateQuerySchema.parse({})),
    getCollectorReport(db, collectorReportQuerySchema.parse({ from: monthStart, to: today })),
    listReceivables(db, receivableListQuerySchema.parse({ view: "overdue", sort: "oldest", pageSize: 5 })),
    listPayments(db, paymentListQuerySchema.parse({ pageSize: 10 })),
  ]);

  const thisMonth = trend.months.at(-1)!;
  return {
    asOf: today,
    month,
    kpis: {
      billedThisMonthCentavos: thisMonth.netBilledCentavos,
      collectedThisMonthCentavos: collections.totals.netCentavos,
      collectionRateBasisPoints: thisMonth.collectionRateBasisPoints,
      receivableCentavos: aging.totalOpenCentavos,
      overdueCentavos: aging.overdueCentavos,
      overdueSubscriberCount: aging.overdueSubscriberCount,
      suspensionCandidateCount: candidates.items.length,
    },
    billingVsCollection: trend.months.map((m) => ({
      month: m.month,
      label: m.label,
      netBilledCentavos: m.netBilledCentavos,
      collectedCentavos: m.collectedCentavos,
      collectionRateBasisPoints: m.collectionRateBasisPoints,
    })),
    paymentMethods: collections.methods.map((m) => ({ method: m.method, paymentCount: m.paymentCount, netCentavos: m.netCentavos })),
    aging: aging.buckets.map((b) => ({ bucket: b.bucket, amountCentavos: b.amountCentavos, accountCount: b.accountCount })),
    collectors: collectorReport.collectors
      .filter((c) => c.batchCount > 0)
      .map((c) => ({
        collectorId: c.collectorId,
        code: c.code,
        fullName: c.fullName,
        batchCount: c.batchCount,
        expectedTotalDueCentavos: c.expectedTotalDueCentavos,
        collectedCentavos: c.cashCollectedCentavos + c.chequeCollectedCentavos,
        shortageCentavos: c.shortageCentavos,
        collectionRateBasisPoints: c.collectionRateBasisPoints,
      })),
    oldestOverdue: overdue.items.map((r) => ({
      subscriberId: r.subscriberId,
      accountNumber: r.accountNumber,
      subscriberName: r.subscriberName,
      serviceAccountId: r.serviceAccountId,
      serviceNumber: r.serviceNumber,
      planCode: r.planCode,
      monthsUnpaid: r.monthsUnpaid,
      oldestDueDate: r.oldestDueDate,
      daysPastDue: r.daysPastDue,
      arrearsCentavos: r.arrearsCentavos,
    })),
    latestPayments: payments.items.map((p) => ({
      id: p.id,
      receiptNumber: p.receiptNumber,
      status: p.status,
      paymentDate: p.paymentDate,
      postedAt: p.postedAt,
      method: p.method,
      amountCentavos: p.amountCentavos,
      subscriberId: p.subscriberId,
      accountNumber: p.accountNumber,
      subscriberName: p.subscriberName,
    })),
  };
}
