import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatPesos, formatRate, type PermissionCode, type VarianceKind } from "@bcis/shared";
import type { CollectorReportDto, CollectorReportRowDto } from "../../../preload/index";
import { todayLocal } from "../payments/paymentLabels";
import { ActionButton, formatDateTime, RowError } from "../subscribers/ProfileParts";
import { Badge } from "../ui/Badge";
import { DateField } from "../ui/DateField";
import { BatchStatusBadge } from "./batchLabels";
import { VarianceBadge } from "./BatchCash";
import { CollectorsScreen } from "./CollectorScreen";

type Tab = "list" | "performance";

interface CollectorsHubProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Collections > Collectors: the collector list, and how each collector performed. */
export function CollectorsHub({ permissions, onSessionExpired }: CollectorsHubProps) {
  const [tab, setTab] = useState<Tab>("list");
  const tabs: { id: Tab; label: string }[] = [
    { id: "list", label: "Collectors" },
    { id: "performance", label: "Performance" },
  ];
  return (
    <div>
      <div role="tablist" aria-label="Collectors view" className="mb-4 flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`rounded px-3 py-1 text-sm ${
              tab === t.id ? "bg-navy text-white" : "border border-slate-300 text-ink hover:bg-slate-50"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "list" ? (
        <CollectorsScreen permissions={permissions} onSessionExpired={onSessionExpired} />
      ) : (
        <CollectorReportScreen onSessionExpired={onSessionExpired} />
      )}
    </div>
  );
}

const firstOfMonth = () => `${todayLocal().slice(0, 8)}01`;

/**
 * Collector report (spec 3.10): per collector, the batches collected in the date range,
 * what was due, cash and cheques collected, cash remitted, shortages and overages, and the
 * collection rate. Cancelled batches are left out.
 */
export function CollectorReportScreen({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayLocal());
  const [report, setReport] = useState<CollectorReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    void window.bcis.batches.collectorReport(from, to).then((r) => {
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
  }, [from, to, onSessionExpired]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const th = "sticky top-0 border-b border-slate-200 bg-slate-50 px-3 py-2 font-medium text-muted";
  const td = "border-b border-slate-100 px-3 py-2";
  const num = `${td} money`;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-navy">Collector Performance</h1>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="w-48">
            <DateField label="Collection date from" value={from} onChange={setFrom} required />
          </div>
          <div className="w-48">
            <DateField label="Collection date to" value={to} onChange={setTo} required />
          </div>
        </div>
        {report && <ActionButton label="Print report" onClick={() => window.print()} />}
      </div>

      {error && <RowError message={`Could not load the report. ${error}`} />}
      {!report && !error && <p className="text-muted">Loading…</p>}

      {report && (
        <>
          <div className="overflow-auto rounded-lg border border-slate-200 bg-surface">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={`${th} text-left`}>
                    Collector
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Batches
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Accounts
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Total due
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Cash
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Cheques
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Remitted
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Shortage
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Overage
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.collectors.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-muted">
                      No collectors.
                    </td>
                  </tr>
                )}
                {report.collectors.map((c) => (
                  <Fragment key={c.collectorId}>
                    <tr>
                      <td className={td}>
                        <button
                          className="text-left font-medium text-accent hover:underline disabled:text-ink disabled:no-underline"
                          disabled={c.batches.length === 0}
                          aria-expanded={expanded.has(c.collectorId)}
                          onClick={() => toggle(c.collectorId)}
                        >
                          {c.batches.length > 0 && (expanded.has(c.collectorId) ? "▾ " : "▸ ")}
                          {c.fullName}
                        </button>
                        <span className="block text-xs text-muted">
                          {c.code}
                          {!c.isActive && " · inactive"}
                        </span>
                      </td>
                      <td className={num}>
                        {c.batchCount}
                        {c.unreconciledCount > 0 && (
                          <span className="block">
                            <Badge tone="warning">{c.unreconciledCount} not reconciled</Badge>
                          </span>
                        )}
                      </td>
                      <td className={num}>{c.accountCount}</td>
                      <Amounts row={c} cell={num} />
                    </tr>
                    {expanded.has(c.collectorId) && <BatchLines row={c} />}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className={td}>All collectors</td>
                  <td className={num}>{report.totals.batchCount}</td>
                  <td className={num}>{report.totals.accountCount}</td>
                  <Amounts row={report.totals} cell={num} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted">
            Rate = cash and cheques collected ÷ total due on the route sheets. Shortages and overages count only once a batch
            is reconciled. Payments made at the office or by GCash are not counted for the collector.
          </p>
          <ReportSheet report={report} />
        </>
      )}
    </div>
  );
}

type Totals = CollectorReportDto["totals"];

function Amounts({ row, cell }: { row: Totals; cell: string }) {
  return (
    <>
      <td className={cell}>{formatPesos(row.expectedTotalDueCentavos)}</td>
      <td className={cell}>{formatPesos(row.cashCollectedCentavos)}</td>
      <td className={cell}>{formatPesos(row.chequeCollectedCentavos)}</td>
      <td className={cell}>{formatPesos(row.remittedCentavos)}</td>
      <td className={`${cell} ${row.shortageCentavos > 0 ? "text-danger" : ""}`}>{formatPesos(row.shortageCentavos)}</td>
      <td className={`${cell} ${row.overageCentavos > 0 ? "text-warning" : ""}`}>{formatPesos(row.overageCentavos)}</td>
      <td className={cell}>{formatRate(row.collectionRateBasisPoints)}</td>
    </>
  );
}

/** The batches behind one collector's line. */
function BatchLines({ row }: { row: CollectorReportRowDto }) {
  const td = "border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs";
  const num = `${td} money`;
  return (
    <>
      {row.batches.map((b) => (
        <tr key={b.id}>
          <td className={`${td} pl-8`}>
            <span className="font-medium">{b.batchNumber}</span> · {b.collectionDate} <BatchStatusBadge status={b.status} />
          </td>
          <td className={td} />
          <td className={num}>{b.accountCount}</td>
          <td className={num}>{formatPesos(b.expectedTotalDueCentavos)}</td>
          <td className={num}>{formatPesos(b.cashCollectedCentavos)}</td>
          <td className={num}>{formatPesos(b.chequeCollectedCentavos)}</td>
          <td className={num}>{formatPesos(b.remittedCentavos)}</td>
          <td className={td} colSpan={2}>
            {b.varianceKind ? (
              <span className="flex items-center justify-end gap-2">
                <VarianceBadge kind={b.varianceKind as VarianceKind} />
                {b.differenceCentavos !== 0 && (
                  <span className="tabular-nums">{formatPesos(Math.abs(b.differenceCentavos ?? 0))}</span>
                )}
              </span>
            ) : (
              <span className="block text-right text-muted">Not reconciled</span>
            )}
          </td>
          <td className={td} />
        </tr>
      ))}
    </>
  );
}

/** Paper version: the same table, every collector's batches listed, printed on its own. */
function ReportSheet({ report }: { report: CollectorReportDto }) {
  const cell = "border border-slate-400 px-1.5 py-1";
  const num = `${cell} text-right tabular-nums`;
  const amounts = (row: Totals) => (
    <>
      <td className={num}>{formatPesos(row.expectedTotalDueCentavos)}</td>
      <td className={num}>{formatPesos(row.cashCollectedCentavos)}</td>
      <td className={num}>{formatPesos(row.chequeCollectedCentavos)}</td>
      <td className={num}>{formatPesos(row.remittedCentavos)}</td>
      <td className={num}>{formatPesos(row.shortageCentavos)}</td>
      <td className={num}>{formatPesos(row.overageCentavos)}</td>
      <td className={num}>{formatRate(row.collectionRateBasisPoints)}</td>
    </>
  );

  return createPortal(
    <div className="print-sheet text-[9pt] text-black">
      <header className="mb-3">
        <div className="text-[12pt] font-semibold">Bukidnon Cable and Internet Services</div>
        <div className="text-[11pt] font-semibold uppercase tracking-wide">Collector Performance Report</div>
        <div>
          Collection dates {report.from} to {report.to} · Printed {formatDateTime(new Date().toISOString())}
        </div>
      </header>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className={`${cell} text-left`}>Collector / batch</th>
            <th className={`${cell} text-right`}>Accounts</th>
            <th className={`${cell} text-right`}>Total due</th>
            <th className={`${cell} text-right`}>Cash</th>
            <th className={`${cell} text-right`}>Cheques</th>
            <th className={`${cell} text-right`}>Remitted</th>
            <th className={`${cell} text-right`}>Shortage</th>
            <th className={`${cell} text-right`}>Overage</th>
            <th className={`${cell} text-right`}>Rate</th>
          </tr>
        </thead>
        <tbody>
          {report.collectors.map((c) => (
            <Fragment key={c.collectorId}>
              <tr className="break-inside-avoid font-semibold">
                <td className={cell}>
                  {c.code} · {c.fullName} ({c.batchCount} batch{c.batchCount === 1 ? "" : "es"}
                  {c.unreconciledCount > 0 ? `, ${c.unreconciledCount} not reconciled` : ""})
                </td>
                <td className={num}>{c.accountCount}</td>
                {amounts(c)}
              </tr>
              {c.batches.map((b) => (
                <tr key={b.id} className="break-inside-avoid">
                  <td className={`${cell} pl-4`}>
                    {b.batchNumber} · {b.collectionDate} · {b.status}
                    {b.varianceKind && b.varianceKind !== "balanced" ? ` · ${b.varianceKind}` : ""}
                  </td>
                  <td className={num}>{b.accountCount}</td>
                  <td className={num}>{formatPesos(b.expectedTotalDueCentavos)}</td>
                  <td className={num}>{formatPesos(b.cashCollectedCentavos)}</td>
                  <td className={num}>{formatPesos(b.chequeCollectedCentavos)}</td>
                  <td className={num}>{formatPesos(b.remittedCentavos)}</td>
                  <td className={num} colSpan={2}>
                    {b.differenceCentavos === null ? "Not reconciled" : formatPesos(b.differenceCentavos)}
                  </td>
                  <td className={cell} />
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={cell}>All collectors</td>
            <td className={num}>{report.totals.accountCount}</td>
            {amounts(report.totals)}
          </tr>
        </tfoot>
      </table>
    </div>,
    document.body,
  );
}
