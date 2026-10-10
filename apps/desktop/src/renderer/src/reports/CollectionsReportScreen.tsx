import { useEffect, useState } from "react";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  REPORT_GROUPING_LABELS,
  REPORT_GROUPINGS,
  collectionsReportQuerySchema,
  formatPesos,
} from "@bcis/shared";
import type {
  CollectionAmountsDto,
  CollectionsPeriodDto,
  CollectionsReportDto,
  CollectionsReportQuery,
  ReportGrouping,
} from "../../../preload/index";
import { todayLocal } from "../payments/paymentLabels";
import { CountTile, MoneyTile } from "../receivables/receivableParts";
import { RowError } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { ExportButtons } from "../ui/ExportButtons";
import { SelectField } from "../ui/SelectField";

const GROUPING_OPTIONS = REPORT_GROUPINGS.map((g) => ({ value: g, label: REPORT_GROUPING_LABELS[g] }));
const firstOfMonth = () => `${todayLocal().slice(0, 8)}01`;

/** Negative nets (a reversal bigger than that day's payments) stay visible as such. */
const money = (centavos: number) => formatPesos(centavos);

type MethodRow = CollectionAmountsDto & { method: string };

interface CollectionsReportScreenProps {
  canExport: boolean;
  onSessionExpired: () => void;
}

/**
 * Collections by day, week (Mon–Sun), month or year over a date range, with net per payment
 * method, and a method summary. Payments count on their payment date; reversals are
 * subtracted on the day they were made.
 */
export function CollectionsReportScreen({ canExport, onSessionExpired }: CollectionsReportScreenProps) {
  const [query, setQuery] = useState<CollectionsReportQuery>({ from: firstOfMonth(), to: todayLocal(), groupBy: "day" });
  const [report, setReport] = useState<CollectionsReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Checked here with the same schema as the server, so an impossible range never goes out.
  const parsed = collectionsReportQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the dates.");

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    void window.bcis.reports.collections(query).then((r) => {
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

  const amountColumns = <T extends CollectionAmountsDto>(): Column<T>[] => [
    { key: "count", header: "Payments", align: "right", render: (r) => r.paymentCount },
    { key: "collected", header: "Collected", align: "right", render: (r) => money(r.collectedCentavos) },
    { key: "reversed", header: "Reversed", align: "right", render: (r) => (r.reversedCentavos ? money(-r.reversedCentavos) : "–") },
    { key: "net", header: "Net", align: "right", render: (r) => <strong>{money(r.netCentavos)}</strong> },
  ];

  const periodColumns: Column<CollectionsPeriodDto>[] = [
    { key: "period", header: "Period", render: (p) => p.label },
    ...amountColumns<CollectionsPeriodDto>(),
    ...PAYMENT_METHODS.map((m) => ({
      key: m,
      header: PAYMENT_METHOD_LABELS[m],
      align: "right" as const,
      render: (p: CollectionsPeriodDto) => (p.netByMethod[m] ? money(p.netByMethod[m]) : "–"),
    })),
  ];

  const methodColumns: Column<MethodRow>[] = [
    { key: "method", header: "Method", render: (m) => PAYMENT_METHOD_LABELS[m.method as keyof typeof PAYMENT_METHOD_LABELS] ?? m.method },
    ...amountColumns<MethodRow>(),
    { key: "reversals", header: "Reversals", align: "right", render: (m) => m.reversalCount },
  ];

  const periodTotals: CollectionsPeriodDto | undefined = report
    ? {
        start: report.from,
        end: report.to,
        label: "Total",
        ...report.totals,
        netByMethod: Object.fromEntries(report.methods.map((m) => [m.method, m.netCentavos])),
      }
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="w-44">
            <DateField label="Payment date from" value={query.from} onChange={(from) => setQuery({ ...query, from })} required />
          </div>
          <div className="w-44">
            <DateField label="Payment date to" value={query.to} onChange={(to) => setQuery({ ...query, to })} required />
          </div>
          <div className="w-40">
            <SelectField
              label="Group by"
              value={query.groupBy}
              options={GROUPING_OPTIONS}
              onChange={(groupBy) => setQuery({ ...query, groupBy: groupBy as ReportGrouping })}
            />
          </div>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportCollections(query, format)}
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
            <MoneyTile label="Collected" centavos={report.totals.collectedCentavos} note={`${report.totals.paymentCount} payments`} />
            <MoneyTile
              label="Reversed"
              centavos={report.totals.reversedCentavos}
              note={`${report.totals.reversalCount} reversal${report.totals.reversalCount === 1 ? "" : "s"}`}
            />
            <MoneyTile label="Net collected" centavos={report.totals.netCentavos} note="Collected less reversed" />
            <CountTile label="Periods" count={report.periods.length} note={REPORT_GROUPING_LABELS[report.groupBy]} />
          </div>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">By payment method</h2>
            <DataTable
              columns={methodColumns}
              rows={report.methods}
              getRowKey={(m) => m.method}
              emptyMessage="No payment methods."
              totals={{ method: "Total", ...report.totals }}
            />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">{REPORT_GROUPING_LABELS[report.groupBy]} collections</h2>
            <DataTable
              columns={periodColumns}
              rows={report.periods}
              getRowKey={(p) => p.start}
              emptyMessage="No periods in this range."
              totals={periodTotals}
            />
          </section>

          <p className="text-xs text-muted">
            A payment counts on its payment date. A reversal is subtracted on the day it was made, so totals for
            earlier periods do not change; a payment reversed later still shows in its own period.
          </p>
        </>
      )}
    </div>
  );
}
