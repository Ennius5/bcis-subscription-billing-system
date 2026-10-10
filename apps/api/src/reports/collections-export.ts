import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, REPORT_GROUPING_LABELS } from "@bcis/shared";
import type { CollectionsReport } from "./collections";
import type { ReportDocument } from "./document";

/** Share of the whole in basis points; null when the whole is zero or negative. */
function share(part: number, whole: number): number | null {
  return whole <= 0 ? null : Math.round((part * 10_000) / whole);
}

/** The Collections report screen as an export: period table (net per method) and method summary. */
export function buildCollectionsDocument(report: CollectionsReport): ReportDocument {
  const { totals } = report;
  return {
    slug: "collections",
    title: "Collections Report",
    period: `${report.from} to ${report.to}, ${REPORT_GROUPING_LABELS[report.groupBy].toLowerCase()}`,
    fileDate: `${report.from}_to_${report.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Collected", value: totals.collectedCentavos, kind: "money" },
      { label: "Reversed", value: totals.reversedCentavos, kind: "money" },
      { label: "Net collected", value: totals.netCentavos, kind: "money" },
      { label: "Payments", value: totals.paymentCount, kind: "count" },
      { label: "Reversals", value: totals.reversalCount, kind: "count" },
    ],
    tables: [
      {
        title: `${REPORT_GROUPING_LABELS[report.groupBy]} collections`,
        columns: [
          { header: "Period", kind: "text", width: 2.4 },
          { header: "Payments", kind: "count" },
          { header: "Collected", kind: "money", width: 1.4 },
          { header: "Reversed", kind: "money", width: 1.4 },
          { header: "Net", kind: "money", width: 1.4 },
          ...PAYMENT_METHODS.map((m) => ({ header: `${PAYMENT_METHOD_LABELS[m]} (net)`, kind: "money" as const, width: 1.3 })),
        ],
        rows: report.periods.map((p) => [
          p.label,
          p.paymentCount,
          p.collectedCentavos,
          p.reversedCentavos,
          p.netCentavos,
          ...PAYMENT_METHODS.map((m) => p.netByMethod[m]),
        ]),
        totals: [
          "Total",
          totals.paymentCount,
          totals.collectedCentavos,
          totals.reversedCentavos,
          totals.netCentavos,
          ...report.methods.map((m) => m.netCentavos),
        ],
      },
      {
        title: "By payment method",
        columns: [
          { header: "Method", kind: "text", width: 2 },
          { header: "Payments", kind: "count" },
          { header: "Collected", kind: "money", width: 1.4 },
          { header: "Reversals", kind: "count" },
          { header: "Reversed", kind: "money", width: 1.4 },
          { header: "Net", kind: "money", width: 1.4 },
          { header: "Share of net", kind: "percent" },
        ],
        rows: report.methods.map((m) => [
          PAYMENT_METHOD_LABELS[m.method],
          m.paymentCount,
          m.collectedCentavos,
          m.reversalCount,
          m.reversedCentavos,
          m.netCentavos,
          share(m.netCentavos, totals.netCentavos),
        ]),
        totals: [
          "Total",
          totals.paymentCount,
          totals.collectedCentavos,
          totals.reversalCount,
          totals.reversedCentavos,
          totals.netCentavos,
          totals.netCentavos > 0 ? 10_000 : null,
        ],
      },
    ],
    notes: [
      "A payment counts on its payment date. A reversal is subtracted on the date it was made, so totals for earlier periods do not change; a payment reversed later still shows in its own period.",
    ],
  };
}
