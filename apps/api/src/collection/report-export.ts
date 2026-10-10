import { COLLECTION_BATCH_STATUS_LABELS, VARIANCE_KIND_LABELS, formatPesos } from "@bcis/shared";
import type { ReportDocument } from "../reports/document";
import type { CollectorReport } from "./report";

/** The Collectors > Performance screen as an export: one line per collector, then every batch. */
export function buildCollectorReportDocument(report: CollectorReport): ReportDocument {
  const t = report.totals;
  return {
    slug: "collector-performance",
    title: "Collector Performance",
    period: `Collection dates ${report.from} to ${report.to}`,
    fileDate: `${report.from}_to_${report.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Total due", value: t.expectedTotalDueCentavos, kind: "money" },
      { label: "Collected (cash + cheques)", value: t.cashCollectedCentavos + t.chequeCollectedCentavos, kind: "money" },
      { label: "Collection rate", value: t.collectionRateBasisPoints, kind: "percent" },
      { label: "Shortages", value: t.shortageCentavos, kind: "money" },
      { label: "Not reconciled", value: t.unreconciledCount, kind: "count" },
    ],
    tables: [
      {
        title: "By collector",
        columns: [
          { header: "Collector", kind: "text", width: 2.2 },
          { header: "Batches", kind: "count", width: 0.8 },
          { header: "Accounts", kind: "count", width: 0.8 },
          { header: "Total due", kind: "money", width: 1.2 },
          { header: "Cash", kind: "money", width: 1.2 },
          { header: "Cheques", kind: "money", width: 1.1 },
          { header: "Remitted", kind: "money", width: 1.2 },
          { header: "Shortage", kind: "money", width: 1.1 },
          { header: "Overage", kind: "money", width: 1.1 },
          { header: "Rate", kind: "percent", width: 0.8 },
        ],
        rows: report.collectors.map((c) => [
          `${c.code} ${c.fullName}${c.isActive ? "" : " (inactive)"}${c.unreconciledCount ? `, ${c.unreconciledCount} not reconciled` : ""}`,
          c.batchCount,
          c.accountCount,
          c.expectedTotalDueCentavos,
          c.cashCollectedCentavos,
          c.chequeCollectedCentavos,
          c.remittedCentavos,
          c.shortageCentavos,
          c.overageCentavos,
          c.collectionRateBasisPoints,
        ]),
        totals: [
          "All collectors",
          t.batchCount,
          t.accountCount,
          t.expectedTotalDueCentavos,
          t.cashCollectedCentavos,
          t.chequeCollectedCentavos,
          t.remittedCentavos,
          t.shortageCentavos,
          t.overageCentavos,
          t.collectionRateBasisPoints,
        ],
        emptyMessage: "No collectors.",
      },
      {
        title: "Batches",
        columns: [
          { header: "Collector", kind: "text", width: 1.6 },
          { header: "Batch", kind: "text", width: 1.1 },
          { header: "Date", kind: "date", width: 1 },
          { header: "Status", kind: "text", width: 1 },
          { header: "Accounts", kind: "count", width: 0.8 },
          { header: "Total due", kind: "money", width: 1.2 },
          { header: "Cash", kind: "money", width: 1.2 },
          { header: "Cheques", kind: "money", width: 1.1 },
          { header: "Remitted", kind: "money", width: 1.2 },
          { header: "Reconciliation", kind: "text", width: 1.6 },
        ],
        rows: report.collectors.flatMap((c) =>
          c.batches.map((b) => [
            c.code,
            b.batchNumber,
            b.collectionDate,
            COLLECTION_BATCH_STATUS_LABELS[b.status],
            b.accountCount,
            b.expectedTotalDueCentavos,
            b.cashCollectedCentavos,
            b.chequeCollectedCentavos,
            b.remittedCentavos,
            b.varianceKind === null
              ? "Not reconciled"
              : b.differenceCentavos
                ? `${VARIANCE_KIND_LABELS[b.varianceKind]} ${formatPesos(Math.abs(b.differenceCentavos))}`
                : VARIANCE_KIND_LABELS[b.varianceKind],
          ]),
        ),
        emptyMessage: "No batches in this period.",
      },
    ],
    notes: [
      "Rate = cash and cheques collected ÷ total due on the route sheets. Shortages and overages count only once a batch is reconciled. Payments made at the office or by GCash are not counted for the collector. Cancelled batches are left out.",
    ],
  };
}
