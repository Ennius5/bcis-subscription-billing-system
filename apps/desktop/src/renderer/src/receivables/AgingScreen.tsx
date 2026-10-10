import { useEffect, useState } from "react";
import { formatPesos } from "@bcis/shared";
import type { AgingBucketDto, AgingReportDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { ExportButtons } from "../ui/ExportButtons";
import {
  BucketBadge,
  CountTile,
  FilterBar,
  MoneyTile,
  NO_FILTERS,
  useFilterOptions,
  type ReceivableFilters,
} from "./receivableParts";

/** Share of the total as "12.5%", from integer centavos (no float money is stored or summed). */
function share(part: number, whole: number): string {
  if (whole === 0) return "–";
  return `${((part * 100) / whole).toFixed(1)}%`;
}

interface AgingScreenProps {
  /** report.export: shows Export PDF / Export Excel (the server checks it again). */
  canExport: boolean;
  onSessionExpired: () => void;
}

/**
 * AR aging (spec 3.9) as of the server's today: each open invoice's balance sits in the
 * bucket of its own due date. Unapplied credit is shown beside it, not netted in.
 */
export function AgingScreen({ canExport, onSessionExpired }: AgingScreenProps) {
  const options = useFilterOptions(onSessionExpired);
  const [filters, setFilters] = useState<ReceivableFilters>(NO_FILTERS);
  const [report, setReport] = useState<AgingReportDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.receivables.aging(filters).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setReport(r.data);
        setLoadError(null);
      } else if (r.code === "UNAUTHENTICATED") {
        onSessionExpired();
      } else {
        setLoadError(r.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filters, onSessionExpired]);

  const columns: Column<AgingBucketDto>[] = [
    { key: "bucket", header: "Days past due", render: (b) => <BucketBadge bucket={b.bucket} /> },
    { key: "invoices", header: "Invoices", align: "right", render: (b) => b.invoiceCount },
    { key: "accounts", header: "Accounts (by oldest bill)", align: "right", render: (b) => b.accountCount },
    { key: "amount", header: "Open balance", align: "right", render: (b) => formatPesos(b.amountCentavos) },
    {
      key: "share",
      header: "Share",
      align: "right",
      render: (b) => share(b.amountCentavos, report?.totalOpenCentavos ?? 0),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-xl font-semibold text-navy">Aging</h1>
          <p className="text-sm text-muted">
            Unpaid invoice balances by how many days they are past due{report && `, as of ${report.asOf}`}.
          </p>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.receivables.exportAging(filters, format)}
            onExpired={onSessionExpired}
            disabled={!report}
          />
        )}
      </div>

      <div className="mb-4 grid grid-cols-4 gap-3">
        <FilterBar value={filters} options={options} onChange={setFilters} />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the aging report. {loadError}
        </p>
      )}

      {!report ? (
        !loadError && <p className="text-muted">Loading…</p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-5 gap-3">
            <MoneyTile label="Total open" centavos={report.totalOpenCentavos} />
            <MoneyTile label="Overdue" centavos={report.overdueCentavos} note={share(report.overdueCentavos, report.totalOpenCentavos)} />
            <CountTile
              label="Overdue accounts"
              count={report.overdueAccountCount}
              note={`${report.overdueSubscriberCount} subscriber${report.overdueSubscriberCount === 1 ? "" : "s"}`}
            />
            <MoneyTile label="Unapplied credit" centavos={report.unappliedCreditCentavos} note="Advance payments not yet used" />
            <MoneyTile label="Net receivable" centavos={report.netReceivableCentavos} note="Total open less credit" />
          </div>
          <DataTable
            columns={columns}
            rows={report.buckets}
            getRowKey={(b) => b.bucket}
            emptyMessage="No unpaid balances."
          />
        </>
      )}
    </div>
  );
}
