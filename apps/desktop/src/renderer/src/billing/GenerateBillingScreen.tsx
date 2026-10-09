import { useEffect, useState } from "react";
import { formatPesos, periodLabel, type PermissionCode } from "@bcis/shared";
import type { ApiResult, BillingSummaryDto, FinalizeResultDto } from "../../../preload/index";
import { InvoiceList } from "./InvoiceList";
import { currentMonth } from "./invoiceStatus";
import { InvoiceView } from "./InvoiceView";
import { MonthField } from "../ui/MonthField";

type Confirming = "finalize" | "discard" | null;

interface GenerateBillingScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

function Tile({ label, count, totalCentavos }: { label: string; count: number; totalCentavos?: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink">{count}</div>
      {totalCentavos !== undefined && <div className="money text-sm text-muted">{formatPesos(totalCentavos)}</div>}
    </div>
  );
}

export function GenerateBillingScreen({ permissions, onSessionExpired }: GenerateBillingScreenProps) {
  const [period, setPeriod] = useState(currentMonth());
  const [summary, setSummary] = useState<BillingSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<FinalizeResultDto["skipped"]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [draftsKey, setDraftsKey] = useState(0);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);

  // Load the month's summary whenever the month changes.
  useEffect(() => {
    if (!period) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    setNotice(null);
    setSkipped([]);
    setConfirming(null);
    void window.bcis.billing.summary(period).then((r) => {
      if (cancelled) return;
      if (r.ok) setSummary(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [period, onSessionExpired]);

  /** Runs one billing action; every action answers with the month's fresh summary. */
  async function act<T extends BillingSummaryDto>(call: () => Promise<ApiResult<T>>, onDone: (data: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirming(null);
    const r = await call();
    setBusy(false);
    if (r.ok) {
      setSummary(r.data);
      setDraftsKey((k) => k + 1);
      onDone(r.data);
    } else if (r.code === "UNAUTHENTICATED") {
      onSessionExpired();
    } else {
      setError(r.message);
    }
  }

  const generate = () =>
    act(
      () => window.bcis.billing.generate(period),
      (s) => {
        setSkipped([]);
        setNotice(`Drafts ready for ${periodLabel(period)}: ${s.drafts.count} invoices, ${formatPesos(s.drafts.totalCentavos)}. Review them below, then finalize.`);
      },
    );

  const discard = () =>
    act(
      () => window.bcis.billing.discardDrafts(period),
      () => {
        setSkipped([]);
        setNotice(`Drafts for ${periodLabel(period)} were discarded.`);
      },
    );

  const finalize = () =>
    act(
      () => window.bcis.billing.finalize(period),
      (r) => {
        setSkipped(r.skipped);
        const range = r.firstNumber === r.lastNumber ? r.firstNumber : `${r.firstNumber} to ${r.lastNumber}`;
        const credit =
          r.creditAppliedCentavos > 0
            ? ` Advance payments of ${formatPesos(r.creditAppliedCentavos)} were applied to the new invoices.`
            : "";
        setNotice(`Finalized ${r.finalizedNow} invoice${r.finalizedNow === 1 ? "" : "s"} for ${periodLabel(period)} (${range}) and posted them to the subscriber ledgers.${credit}`);
      },
    );

  if (openInvoiceId) {
    return (
      <InvoiceView
        key={openInvoiceId}
        invoiceId={openInvoiceId}
        canVoid={permissions.includes("billing.void")}
        canAdjust={permissions.includes("billing.adjust")}
        backLabel="Back to Generate Billing"
        onBack={() => setOpenInvoiceId(null)}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  const drafts = summary?.drafts.count ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-navy">Generate Billing</h1>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-56">
          <MonthField
            label="Billing month"
            value={period}
            // A billing run always needs a month, so clearing the picker keeps the last one.
            onChange={(value) => value && setPeriod(value)}
            required
            hint="Up to one month ahead (advance billing)."
          />
        </div>
        <p className="pb-6 text-sm text-muted">
          Invoices are dated the 1st and due on each account's billing day. Only active accounts are billed, a full month
          each.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p aria-live="polite" className="rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      )}
      {skipped.length > 0 && (
        <div role="alert" className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          {skipped.length} draft{skipped.length === 1 ? " was" : "s were"} left unfinalized because the service account is
          no longer active: {skipped.map((s) => `${s.serviceNumber} (${s.accountStatus})`).join(", ")}. Discard drafts to
          remove {skipped.length === 1 ? "it" : "them"}.
        </div>
      )}

      {!summary && !error && <p className="text-muted">Loading…</p>}

      {summary && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <Tile label="Not yet billed" count={summary.notYetBilled} />
            <Tile label="Drafts" count={summary.drafts.count} totalCentavos={summary.drafts.totalCentavos} />
            <Tile label="Finalized" count={summary.finalized.count} totalCentavos={summary.finalized.totalCentavos} />
            <Tile label="Voided" count={summary.voided.count} totalCentavos={summary.voided.totalCentavos} />
          </div>

          {confirming === null && (
            <div className="flex flex-wrap gap-3">
              <button
                className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-50"
                disabled={busy || summary.notYetBilled === 0}
                onClick={() => void generate()}
                title={summary.notYetBilled === 0 ? "Every billable account already has an invoice for this month." : undefined}
              >
                {busy ? "Working…" : `Generate drafts (${summary.notYetBilled})`}
              </button>
              <button
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                disabled={busy || drafts === 0}
                onClick={() => setConfirming("finalize")}
              >
                Finalize {drafts} draft{drafts === 1 ? "" : "s"}
              </button>
              <button
                className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-slate-50 disabled:opacity-50"
                disabled={busy || drafts === 0}
                onClick={() => setConfirming("discard")}
              >
                Discard drafts
              </button>
            </div>
          )}

          {confirming === "finalize" && (
            <div className="rounded-lg border border-accent/30 bg-slate-50 p-4">
              <p className="text-sm text-ink">
                Finalize <strong>{drafts}</strong> draft invoice{drafts === 1 ? "" : "s"} for{" "}
                <strong>{periodLabel(period)}</strong> totalling{" "}
                <strong className="money">{formatPesos(summary.drafts.totalCentavos)}</strong>?
              </p>
              <p className="mt-1 text-sm text-muted">
                Each gets an invoice number and is posted to the subscriber's ledger. Finalized invoices cannot be edited;
                mistakes are corrected by voiding.
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
                  onClick={() => void finalize()}
                >
                  Yes, finalize
                </button>
                <button
                  className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-white"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {confirming === "discard" && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
              <p className="text-sm text-ink">
                Discard all {drafts} draft{drafts === 1 ? "" : "s"} for {periodLabel(period)}? Finalized invoices are not
                affected. You can generate the drafts again afterwards, for example after correcting a rate.
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90"
                  onClick={() => void discard()}
                >
                  Yes, discard drafts
                </button>
                <button
                  className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-white"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Drafts for {periodLabel(period)}
            </h2>
            <InvoiceList
              fixed={{ period, status: "draft" }}
              reloadKey={draftsKey}
              emptyMessage="No drafts for this month."
              onOpen={setOpenInvoiceId}
              onSessionExpired={onSessionExpired}
            />
          </section>
        </>
      )}
    </div>
  );
}
