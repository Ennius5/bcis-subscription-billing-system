import { useCallback, useEffect, useState } from "react";
import {
  AGING_BUCKET_LABELS,
  type AgingBucket,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  formatPesos,
  formatRate,
  periodLabel,
} from "@bcis/shared";
import type { DashboardDto } from "../../../preload/index";
import { methodLabel, PaymentStatusBadge } from "../payments/paymentLabels";
import { formatDateTime, RowError } from "../subscribers/ProfileParts";
import { DataTable } from "../ui/DataTable";
import { ChartCard, ColumnPairChart, HBarList, Legend, RateMeter } from "./charts";

type Collector = DashboardDto["collectors"][number];
type Overdue = DashboardDto["oldestOverdue"][number];
type Payment = DashboardDto["latestPayments"][number];
type Trend = DashboardDto["billingVsCollection"][number];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10" -> "Oct ’26" for the chart's x axis. */
const shortMonth = (month: string) => `${SHORT_MONTHS[Number(month.slice(5, 7)) - 1]} ’${month.slice(2, 4)}`;

const SERIES = [
  { label: "Net billed", color: "var(--color-series-1)" },
  { label: "Collected", color: "var(--color-series-2)" },
];

interface KpiTileProps {
  label: string;
  value: string;
  note?: string;
  /** Opens the screen behind the figure, when the user may see it. */
  action?: { label: string; onClick: () => void };
}

/** Stat tile: proportional figures for the big value (tabular only in columns). */
function KpiTile({ label, value, note, action }: KpiTileProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
        <span>{note}</span>
        {action && (
          <button className="text-accent hover:underline" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

interface DashboardScreenProps {
  canOpenSubscriber: boolean;
  onOpenSubscriber: (id: string) => void;
  /** Navigates to a menu screen; returns false (and does nothing) when the user cannot see it. */
  canNavigate: (screenId: string) => boolean;
  onNavigate: (screenId: string) => void;
  onSessionExpired: () => void;
}

/**
 * Dashboard (spec 4.3): six KPIs, billing vs collection, this month's payment methods, AR
 * aging, collector performance, the oldest overdue accounts and the latest payments. Every
 * figure comes from the same services as its report, as of today.
 */
export function DashboardScreen({ canOpenSubscriber, onOpenSubscriber, canNavigate, onNavigate, onSessionExpired }: DashboardScreenProps) {
  const [data, setData] = useState<DashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    return window.bcis.dashboard.get().then((r) => {
      setLoading(false);
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const link = (screenId: string, label: string) =>
    canNavigate(screenId) ? { label, onClick: () => onNavigate(screenId) } : undefined;
  const subscriber = (id: string, name: string, account: string) => (
    <>
      {canOpenSubscriber ? (
        <button className="font-medium text-accent hover:underline" onClick={() => onOpenSubscriber(id)}>
          {name}
        </button>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      <span className="block text-xs text-muted">{account}</span>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-navy">Dashboard</h1>
          {data && (
            <p className="text-sm text-muted">
              {periodLabel(data.month)} so far · as of {data.asOf}
            </p>
          )}
        </div>
        <button
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading && data ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <RowError message={`Could not load the dashboard. ${error}`} />}
      {!data && !error && <p className="text-muted">Loading…</p>}

      {data && (
        // While refreshing, the previous figures stay in place, dimmed (no layout jump).
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-3 gap-3">
            <KpiTile label="Billed this month" value={formatPesos(data.kpis.billedThisMonthCentavos)} note="Invoices plus adjustments" />
            <KpiTile label="Collected this month" value={formatPesos(data.kpis.collectedThisMonthCentavos)} note="Payments less reversals" />
            <KpiTile
              label="Collection rate"
              value={formatRate(data.kpis.collectionRateBasisPoints)}
              note="Collected ÷ billed this month"
              action={link("reports", "Reports")}
            />
            <KpiTile
              label="Total receivable"
              value={formatPesos(data.kpis.receivableCentavos)}
              note="Unpaid invoice balances"
              action={link("receivables.aging", "Aging")}
            />
            <KpiTile
              label="Overdue"
              value={formatPesos(data.kpis.overdueCentavos)}
              note={`${data.kpis.overdueSubscriberCount} subscriber${data.kpis.overdueSubscriberCount === 1 ? "" : "s"}`}
              action={link("receivables.overdue", "Overdue list")}
            />
            <KpiTile
              label="Suspension candidates"
              value={data.kpis.suspensionCandidateCount.toLocaleString()}
              note="Past the grace period"
              action={link("receivables.suspension", "Review")}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <ChartCard
              className="col-span-2"
              title="Billing vs collection"
              subtitle="Last six billing months"
              legend={<Legend items={SERIES} />}
              chart={
                <ColumnPairChart
                  series={SERIES}
                  format={formatPesos}
                  groups={data.billingVsCollection.map((m) => ({
                    key: m.month,
                    label: shortMonth(m.month),
                    values: [m.netBilledCentavos, m.collectedCentavos],
                    note: `Collection rate ${formatRate(m.collectionRateBasisPoints)}`,
                  }))}
                />
              }
              table={
                <DataTable<Trend>
                  columns={[
                    { key: "month", header: "Month", render: (m) => m.label },
                    { key: "billed", header: "Net billed", align: "right", render: (m) => formatPesos(m.netBilledCentavos) },
                    { key: "collected", header: "Collected", align: "right", render: (m) => formatPesos(m.collectedCentavos) },
                    { key: "rate", header: "Rate", align: "right", render: (m) => formatRate(m.collectionRateBasisPoints) },
                  ]}
                  rows={data.billingVsCollection}
                  getRowKey={(m) => m.month}
                  emptyMessage="No months."
                />
              }
            />
            <ChartCard
              title="Payment methods"
              subtitle={`${periodLabel(data.month)}, net of reversals`}
              chart={
                <HBarList
                  format={formatPesos}
                  rows={data.paymentMethods.map((m) => ({
                    key: m.method,
                    label: PAYMENT_METHOD_LABELS[m.method as PaymentMethod] ?? m.method,
                    value: m.netCentavos,
                    note: `· ${m.paymentCount}`,
                  }))}
                />
              }
              table={
                <DataTable
                  columns={[
                    { key: "method", header: "Method", render: (m) => methodLabel(m.method) },
                    { key: "count", header: "Payments", align: "right", render: (m) => m.paymentCount },
                    { key: "net", header: "Net", align: "right", render: (m) => formatPesos(m.netCentavos) },
                  ]}
                  rows={data.paymentMethods}
                  getRowKey={(m) => m.method}
                  emptyMessage="No payments."
                />
              }
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <ChartCard
              title="Receivable aging"
              subtitle="Unpaid balances by days past due"
              chart={
                <HBarList
                  format={formatPesos}
                  rows={data.aging.map((b) => ({
                    key: b.bucket,
                    label: AGING_BUCKET_LABELS[b.bucket as AgingBucket] ?? b.bucket,
                    value: b.amountCentavos,
                    note: `· ${b.accountCount} acct${b.accountCount === 1 ? "" : "s"}`,
                  }))}
                />
              }
              table={
                <DataTable
                  columns={[
                    { key: "bucket", header: "Days past due", render: (b) => AGING_BUCKET_LABELS[b.bucket as AgingBucket] ?? b.bucket },
                    { key: "accounts", header: "Accounts", align: "right", render: (b) => b.accountCount },
                    { key: "amount", header: "Open balance", align: "right", render: (b) => formatPesos(b.amountCentavos) },
                  ]}
                  rows={data.aging}
                  getRowKey={(b) => b.bucket}
                  emptyMessage="No unpaid balances."
                />
              }
            />
            <ChartCard
              className="col-span-2"
              title="Collector performance"
              subtitle={`Batches dated ${periodLabel(data.month)}`}
              table={
                <DataTable<Collector>
                  columns={[
                    {
                      key: "collector",
                      header: "Collector",
                      render: (c) => (
                        <>
                          <span className="font-medium">{c.fullName}</span>
                          <span className="block text-xs text-muted">
                            {c.code} · {c.batchCount} batch{c.batchCount === 1 ? "" : "es"}
                          </span>
                        </>
                      ),
                    },
                    { key: "due", header: "Total due", align: "right", render: (c) => formatPesos(c.expectedTotalDueCentavos) },
                    { key: "collected", header: "Collected", align: "right", render: (c) => formatPesos(c.collectedCentavos) },
                    {
                      key: "short",
                      header: "Shortage",
                      align: "right",
                      render: (c) => (c.shortageCentavos ? <span className="text-danger">{formatPesos(c.shortageCentavos)}</span> : "–"),
                    },
                    {
                      key: "rate",
                      header: "Rate",
                      align: "right",
                      render: (c) => <RateMeter basisPoints={c.collectionRateBasisPoints} text={formatRate(c.collectionRateBasisPoints)} />,
                    },
                  ]}
                  rows={data.collectors}
                  getRowKey={(c) => c.collectorId}
                  emptyMessage="No collection batches this month."
                />
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ChartCard
              title="Oldest overdue"
              subtitle="Five accounts with the oldest unpaid bill"
              table={
                <DataTable<Overdue>
                  columns={[
                    { key: "who", header: "Subscriber", render: (r) => subscriber(r.subscriberId, r.subscriberName, r.accountNumber) },
                    {
                      key: "service",
                      header: "Service",
                      render: (r) => (
                        <>
                          {r.serviceNumber}
                          <span className="block text-xs text-muted">{r.planCode}</span>
                        </>
                      ),
                    },
                    {
                      key: "age",
                      header: "Oldest due",
                      render: (r) => (
                        <>
                          {r.oldestDueDate}
                          <span className="block text-xs text-muted">
                            {r.daysPastDue} days · {r.monthsUnpaid} month{r.monthsUnpaid === 1 ? "" : "s"}
                          </span>
                        </>
                      ),
                    },
                    { key: "arrears", header: "Arrears", align: "right", render: (r) => formatPesos(r.arrearsCentavos) },
                  ]}
                  rows={data.oldestOverdue}
                  getRowKey={(r) => r.serviceAccountId}
                  emptyMessage="Nothing is overdue."
                />
              }
            />
            <ChartCard
              title="Latest payments"
              subtitle="Ten most recently posted"
              table={
                <DataTable<Payment>
                  columns={[
                    {
                      key: "receipt",
                      header: "Receipt",
                      render: (p) => (
                        <>
                          {p.receiptNumber}
                          <span className="block text-xs text-muted">{formatDateTime(p.postedAt)}</span>
                        </>
                      ),
                    },
                    { key: "who", header: "Subscriber", render: (p) => subscriber(p.subscriberId, p.subscriberName, p.accountNumber) },
                    {
                      key: "method",
                      header: "Method",
                      render: (p) => (
                        <>
                          {methodLabel(p.method)}
                          {p.status !== "posted" && (
                            <span className="block">
                              <PaymentStatusBadge status={p.status} />
                            </span>
                          )}
                        </>
                      ),
                    },
                    { key: "amount", header: "Amount", align: "right", render: (p) => formatPesos(p.amountCentavos) },
                  ]}
                  rows={data.latestPayments}
                  getRowKey={(p) => p.id}
                  emptyMessage="No payments yet."
                />
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
