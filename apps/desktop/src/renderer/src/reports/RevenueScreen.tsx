import { useEffect, useState } from "react";
import {
  REVENUE_DIMENSION_LABELS,
  REVENUE_DIMENSIONS,
  addMonths,
  formatPesos,
  formatRate,
  revenueQuerySchema,
} from "@bcis/shared";
import type { RevenueDimension, RevenueQuery, RevenueReportDto, RevenueRowDto } from "../../../preload/index";
import { currentMonth } from "../billing/invoiceStatus";
import { CountTile, MoneyTile } from "../receivables/receivableParts";
import { RowError } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { ExportButtons } from "../ui/ExportButtons";
import { MonthField } from "../ui/MonthField";
import { SelectField } from "../ui/SelectField";

const DIMENSION_OPTIONS = REVENUE_DIMENSIONS.map((d) => ({ value: d, label: REVENUE_DIMENSION_LABELS[d] }));
const amount = (centavos: number) => (centavos ? formatPesos(centavos) : "–");

interface RevenueScreenProps {
  canExport: boolean;
  onSessionExpired: () => void;
}

/** Billed revenue by plan, service type or area over billing months, split by invoice line type. */
export function RevenueScreen({ canExport, onSessionExpired }: RevenueScreenProps) {
  const [query, setQuery] = useState<RevenueQuery>(() => ({
    from: addMonths(currentMonth(), -5),
    to: currentMonth(),
    dimension: "plan",
  }));
  const [report, setReport] = useState<RevenueReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = revenueQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the months.");

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    void window.bcis.reports.revenue(query).then((r) => {
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

  const columns: Column<RevenueRowDto>[] = [
    { key: "label", header: REVENUE_DIMENSION_LABELS[report?.dimension ?? query.dimension], render: (r) => r.label },
    { key: "invoices", header: "Invoices", align: "right", render: (r) => r.invoiceCount },
    { key: "subscription", header: "Subscription", align: "right", render: (r) => amount(r.subscriptionCentavos) },
    { key: "installation", header: "Installation", align: "right", render: (r) => amount(r.installationCentavos) },
    { key: "reconnection", header: "Reconnection", align: "right", render: (r) => amount(r.reconnectionCentavos) },
    { key: "other", header: "Other", align: "right", render: (r) => amount(r.otherCentavos) },
    { key: "adjustments", header: "Adjustments", align: "right", render: (r) => amount(r.adjustmentsCentavos) },
    { key: "net", header: "Net revenue", align: "right", render: (r) => <strong>{formatPesos(r.netCentavos)}</strong> },
    { key: "share", header: "Share", align: "right", render: (r) => formatRate(r.shareBasisPoints) },
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
          <div className="w-40">
            <SelectField
              label="Group by"
              value={query.dimension}
              options={DIMENSION_OPTIONS}
              onChange={(dimension) => setQuery({ ...query, dimension: dimension as RevenueDimension })}
            />
          </div>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportRevenue(query, format)}
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
            <MoneyTile label="Billed" centavos={report.totals.billedCentavos} />
            <MoneyTile label="Adjustments" centavos={report.totals.adjustmentsCentavos} note="Debits less credits" />
            <MoneyTile label="Net revenue" centavos={report.totals.netCentavos} />
            <CountTile label="Invoices" count={report.totals.invoiceCount} />
          </div>
          <DataTable
            columns={columns}
            rows={report.rows}
            getRowKey={(r) => r.key}
            emptyMessage="Nothing was billed in these months."
            totals={{ key: "total", label: "Total", shareBasisPoints: report.totals.netCentavos > 0 ? 10_000 : null, ...report.totals }}
          />
          <p className="text-xs text-muted">
            Billed revenue: finalized invoices of the billing months, voided invoices excluded; adjustments count in the
            month they were posted.{" "}
            {report.dimension === "area"
              ? "Area is the subscriber's current collection area."
              : "Plan is the plan billed on each invoice, so later plan changes do not move past revenue."}
          </p>
        </>
      )}
    </div>
  );
}
