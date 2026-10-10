import { useEffect, useState } from "react";
import { addMonths, billingVsCollectionQuerySchema, formatPesos, formatRate } from "@bcis/shared";
import type { BillingVsCollectionAmountsDto, BillingVsCollectionDto, MonthRangeQuery } from "../../../preload/index";
import { currentMonth } from "../billing/invoiceStatus";
import { MoneyTile } from "../receivables/receivableParts";
import { RowError } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { ExportButtons } from "../ui/ExportButtons";
import { MonthField } from "../ui/MonthField";

type Row = BillingVsCollectionAmountsDto & { month: string; label: string };

interface BillingVsCollectionScreenProps {
  canExport: boolean;
  onSessionExpired: () => void;
}

/**
 * What was billed each billing month against what was collected in that month. Billed is
 * finalized, non-void invoices plus adjustments posted that month; collected is payments by
 * payment date less reversals, for bills of any month.
 */
export function BillingVsCollectionScreen({ canExport, onSessionExpired }: BillingVsCollectionScreenProps) {
  const [query, setQuery] = useState<MonthRangeQuery>(() => ({ from: addMonths(currentMonth(), -5), to: currentMonth() }));
  const [report, setReport] = useState<BillingVsCollectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = billingVsCollectionQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the months.");

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    void window.bcis.reports.billingVsCollection(query).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setReport(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [query, queryProblem, onSessionExpired]);

  const columns: Column<Row>[] = [
    { key: "month", header: "Month", render: (r) => r.label },
    { key: "invoices", header: "Invoices", align: "right", render: (r) => r.invoiceCount },
    { key: "billed", header: "Billed", align: "right", render: (r) => formatPesos(r.billedCentavos) },
    {
      key: "adjustments",
      header: "Adjustments",
      align: "right",
      render: (r) => (r.adjustmentsCentavos ? formatPesos(r.adjustmentsCentavos) : "–"),
    },
    { key: "net", header: "Net billed", align: "right", render: (r) => <strong>{formatPesos(r.netBilledCentavos)}</strong> },
    { key: "collected", header: "Collected", align: "right", render: (r) => <strong>{formatPesos(r.collectedCentavos)}</strong> },
    { key: "rate", header: "Rate", align: "right", render: (r) => formatRate(r.collectionRateBasisPoints) },
    { key: "gap", header: "Not collected", align: "right", render: (r) => formatPesos(r.gapCentavos) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="w-44">
            <MonthField label="From month" value={query.from} onChange={(from) => setQuery({ ...query, from })} required />
          </div>
          <div className="w-44">
            <MonthField label="To month" value={query.to} onChange={(to) => setQuery({ ...query, to })} required />
          </div>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportBillingVsCollection(query, format)}
            onExpired={onSessionExpired}
            disabled={queryProblem !== null || !report}
          />
        )}
      </div>

      {queryProblem && <RowError message={queryProblem} />}
      {error && <RowError message={`Could not load the report. ${error}`} />}
      {!report && !error && !queryProblem && <p className="text-muted">Loading…</p>}

      {report && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <MoneyTile label="Net billed" centavos={report.totals.netBilledCentavos} note={`${report.totals.invoiceCount} invoices`} />
            <MoneyTile label="Collected" centavos={report.totals.collectedCentavos} note="Less reversals" />
            <div className="rounded-lg border border-slate-200 bg-surface p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">Collection rate</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{formatRate(report.totals.collectionRateBasisPoints)}</div>
              <div className="text-xs text-muted">Collected ÷ net billed</div>
            </div>
            <MoneyTile label="Not collected" centavos={report.totals.gapCentavos} note="Net billed less collected" />
          </div>
          <DataTable
            columns={columns}
            rows={report.months}
            getRowKey={(r) => r.month}
            emptyMessage="No months in this range."
            totals={{ month: "total", label: "Total", ...report.totals }}
          />
          <p className="text-xs text-muted">
            Billed: finalized invoices of each billing month, voided invoices excluded; adjustments count in the month they
            were posted. Collected includes payments toward older bills, so a month's rate can be above 100%.
          </p>
        </>
      )}
    </div>
  );
}
