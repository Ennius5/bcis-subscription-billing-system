import { REVENUE_DIMENSION_LABELS, periodLabel } from "@bcis/shared";
import type { BillingVsCollectionReport, RevenueReport } from "./billing";
import type { ReportDocument } from "./document";

const monthRange = (from: string, to: string) => (from === to ? periodLabel(from) : `${periodLabel(from)} to ${periodLabel(to)}`);

export function buildBillingVsCollectionDocument(report: BillingVsCollectionReport): ReportDocument {
  const t = report.totals;
  return {
    slug: "billing-vs-collection",
    title: "Billing vs Collection",
    period: monthRange(report.from, report.to),
    fileDate: `${report.from}_to_${report.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Net billed", value: t.netBilledCentavos, kind: "money" },
      { label: "Collected", value: t.collectedCentavos, kind: "money" },
      { label: "Collection rate", value: t.collectionRateBasisPoints, kind: "percent" },
      { label: "Not collected", value: t.gapCentavos, kind: "money" },
    ],
    tables: [
      {
        columns: [
          { header: "Month", kind: "text", width: 1.6 },
          { header: "Invoices", kind: "count" },
          { header: "Billed", kind: "money", width: 1.4 },
          { header: "Adjustments", kind: "money", width: 1.4 },
          { header: "Net billed", kind: "money", width: 1.4 },
          { header: "Collected", kind: "money", width: 1.4 },
          { header: "Rate", kind: "percent" },
          { header: "Not collected", kind: "money", width: 1.4 },
        ],
        rows: report.months.map((m) => [
          m.label,
          m.invoiceCount,
          m.billedCentavos,
          m.adjustmentsCentavos,
          m.netBilledCentavos,
          m.collectedCentavos,
          m.collectionRateBasisPoints,
          m.gapCentavos,
        ]),
        totals: [
          "Total",
          t.invoiceCount,
          t.billedCentavos,
          t.adjustmentsCentavos,
          t.netBilledCentavos,
          t.collectedCentavos,
          t.collectionRateBasisPoints,
          t.gapCentavos,
        ],
      },
    ],
    notes: [
      "Billed: finalized invoices of each billing month, voided invoices excluded. Adjustments count in the month they were posted.",
      "Collected: payments by payment date less reversals by the date they were made, for any month's bills, so a month's rate can exceed 100% when arrears are paid.",
    ],
  };
}

export function buildRevenueDocument(report: RevenueReport): ReportDocument {
  const t = report.totals;
  const dimension = REVENUE_DIMENSION_LABELS[report.dimension];
  return {
    slug: `revenue-by-${report.dimension.replace("_", "-")}`,
    title: `Revenue by ${dimension}`,
    period: monthRange(report.from, report.to),
    fileDate: `${report.from}_to_${report.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Billed", value: t.billedCentavos, kind: "money" },
      { label: "Adjustments", value: t.adjustmentsCentavos, kind: "money" },
      { label: "Net revenue", value: t.netCentavos, kind: "money" },
      { label: "Invoices", value: t.invoiceCount, kind: "count" },
    ],
    tables: [
      {
        columns: [
          { header: dimension, kind: "text", width: 2.4 },
          { header: "Invoices", kind: "count" },
          { header: "Subscription", kind: "money", width: 1.4 },
          { header: "Installation", kind: "money", width: 1.3 },
          { header: "Reconnection", kind: "money", width: 1.3 },
          { header: "Other", kind: "money", width: 1.2 },
          { header: "Adjustments", kind: "money", width: 1.3 },
          { header: "Net revenue", kind: "money", width: 1.4 },
          { header: "Share", kind: "percent" },
        ],
        rows: report.rows.map((r) => [
          r.label,
          r.invoiceCount,
          r.subscriptionCentavos,
          r.installationCentavos,
          r.reconnectionCentavos,
          r.otherCentavos,
          r.adjustmentsCentavos,
          r.netCentavos,
          r.shareBasisPoints,
        ]),
        totals: [
          "Total",
          t.invoiceCount,
          t.subscriptionCentavos,
          t.installationCentavos,
          t.reconnectionCentavos,
          t.otherCentavos,
          t.adjustmentsCentavos,
          t.netCentavos,
          t.netCentavos > 0 ? 10_000 : null,
        ],
        emptyMessage: "Nothing was billed in these months.",
      },
    ],
    notes: [
      "Revenue is billed revenue: finalized invoices of the billing months, voided invoices excluded; adjustments count in the month they were posted.",
      report.dimension === "area"
        ? "Area is the subscriber's current collection area."
        : "Plan is the plan billed on the invoice, so later plan changes do not move past revenue.",
    ],
  };
}
