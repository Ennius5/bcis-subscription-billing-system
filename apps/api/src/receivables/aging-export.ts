import { AGING_BUCKET_LABELS, type AgingQuery, SERVICE_TYPE_LABELS } from "@bcis/shared";
import type { ReportDocument } from "../reports/document";
import type { AgingReport, ReceivableFilterOptions } from "./service";

/** The applied receivable filters as readable lines ("Collector: COL-01 Juan Dela Cruz"). */
export function describeReceivableFilters(
  query: AgingQuery,
  options: ReceivableFilterOptions,
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  if (query.collectorId) {
    const c = options.collectors.find((x) => x.id === query.collectorId);
    lines.push({ label: "Collector", value: c ? `${c.code} ${c.fullName}` : "Unknown collector" });
  }
  if (query.areaId) {
    const a = options.areas.find((x) => x.id === query.areaId);
    lines.push({ label: "Area", value: a ? `${a.code} ${a.name}` : "Unknown area" });
  }
  if (query.serviceType) lines.push({ label: "Service type", value: SERVICE_TYPE_LABELS[query.serviceType] });
  if (query.planId) {
    const p = options.plans.find((x) => x.id === query.planId);
    lines.push({ label: "Plan", value: p ? `${p.code} ${p.name}` : "Unknown plan" });
  }
  return lines;
}

/** Share of the total in basis points (integer arithmetic on centavos); null when nothing is open. */
function shareBasisPoints(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part * 10_000) / whole);
}

/** The Aging screen as an export: the same five figures and bucket table. */
export function buildAgingDocument(
  report: AgingReport,
  filters: { label: string; value: string }[],
): ReportDocument {
  return {
    slug: "ar-aging",
    title: "Accounts Receivable Aging",
    period: `As of ${report.asOf}`,
    fileDate: report.asOf,
    filters,
    figures: [
      { label: "Total open", value: report.totalOpenCentavos, kind: "money" },
      { label: "Overdue", value: report.overdueCentavos, kind: "money" },
      { label: "Overdue accounts", value: report.overdueAccountCount, kind: "count" },
      { label: "Unapplied credit", value: report.unappliedCreditCentavos, kind: "money" },
      { label: "Net receivable", value: report.netReceivableCentavos, kind: "money" },
    ],
    tables: [
      {
        columns: [
          { header: "Days past due", kind: "text", width: 2 },
          { header: "Invoices", kind: "count" },
          { header: "Accounts (by oldest bill)", kind: "count", width: 2 },
          { header: "Open balance", kind: "money", width: 2 },
          { header: "Share", kind: "percent" },
        ],
        rows: report.buckets.map((b) => [
          AGING_BUCKET_LABELS[b.bucket],
          b.invoiceCount,
          b.accountCount,
          b.amountCentavos,
          shareBasisPoints(b.amountCentavos, report.totalOpenCentavos),
        ]),
        totals: [
          "Total",
          report.buckets.reduce((n, b) => n + b.invoiceCount, 0),
          report.buckets.reduce((n, b) => n + b.accountCount, 0),
          report.totalOpenCentavos,
          report.totalOpenCentavos === 0 ? null : 10_000,
        ],
      },
    ],
    notes: [
      "Each open invoice balance is placed by its own due date. Accounts are counted once, in the bucket of their oldest unpaid bill.",
      `Overdue subscribers: ${report.overdueSubscriberCount}. Unapplied credit (advance payments not yet used) is shown separately and not netted into the buckets.`,
    ],
  };
}
