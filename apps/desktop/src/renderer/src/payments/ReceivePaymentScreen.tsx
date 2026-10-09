import { useEffect, useMemo, useState } from "react";
import {
  allocateOldestFirst,
  formatPesos,
  paymentCreateSchema,
  periodLabel,
  periodOf,
  planManualAllocation,
  tryParsePesos,
  type AllocationPlan,
  type PermissionCode,
} from "@bcis/shared";
import type { PaymentContextDto, PaymentDetailDto } from "../../../preload/index";
import { InvoiceStatusBadge } from "../billing/invoiceStatus";
import { useSave } from "../service-accounts/useSave";
import { schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { StatusBadge } from "../subscribers/status";
import { DateField } from "../ui/DateField";
import { centavosToInput, MoneyField } from "../ui/MoneyField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { COUNTER_METHOD_OPTIONS, todayLocal } from "./paymentLabels";
import { Receipt } from "./Receipt";
import { SubscriberPicker } from "./SubscriberPicker";

interface ReceivePaymentScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Receive Payment (spec 4.1): search, balance, amount, method, allocation preview, post, print receipt. */
export function ReceivePaymentScreen({ permissions, onSessionExpired }: ReceivePaymentScreenProps) {
  const [subscriberId, setSubscriberId] = useState<string | null>(null);
  const [posted, setPosted] = useState<PaymentDetailDto | null>(null);
  // Remounts the form for a fresh payment (fresh balances) for the same subscriber.
  const [formKey, setFormKey] = useState(0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-navy">Receive Payment</h1>

      {posted ? (
        <PostedPanel
          payment={posted}
          onAnotherForSame={() => {
            setPosted(null);
            setFormKey((k) => k + 1);
          }}
          onNewSubscriber={() => {
            setPosted(null);
            setSubscriberId(null);
          }}
        />
      ) : subscriberId ? (
        <PaymentForm
          key={`${subscriberId}-${formKey}`}
          subscriberId={subscriberId}
          canAllocate={permissions.includes("payment.allocate")}
          onPosted={setPosted}
          onChangeSubscriber={() => setSubscriberId(null)}
          onSessionExpired={onSessionExpired}
        />
      ) : (
        <SubscriberPicker onPick={setSubscriberId} onSessionExpired={onSessionExpired} />
      )}
    </div>
  );
}

/* ------------------------------ The form ------------------------------ */

interface PaymentFormProps {
  subscriberId: string;
  canAllocate: boolean;
  onPosted: (payment: PaymentDetailDto) => void;
  onChangeSubscriber: () => void;
  onSessionExpired: () => void;
}

type Preview = { ok: true; plan: AllocationPlan } | { ok: false; problem: string } | null;

function PaymentForm({ subscriberId, canAllocate, onPosted, onChangeSubscriber, onSessionExpired }: PaymentFormProps) {
  const [context, setContext] = useState<PaymentContextDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayLocal());
  const [notes, setNotes] = useState("");
  const [manual, setManual] = useState(false);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const { errors, formError, saving, reject, save } = useSave(onPosted, onSessionExpired);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.payments.context(subscriberId).then((r) => {
      if (cancelled) return;
      if (r.ok) setContext(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, onSessionExpired]);

  const amount = tryParsePesos(amountText);
  const openInvoices = useMemo(() => context?.openInvoices ?? [], [context]);
  const totalOpen = openInvoices.reduce((sum, i) => sum + i.balanceCentavos, 0);

  const manualRequests = useMemo(
    () =>
      Object.entries(manualAmounts)
        .filter(([, text]) => text.trim() !== "")
        .map(([invoiceId, text]) => ({ invoiceId, amountCentavos: tryParsePesos(text) })),
    [manualAmounts],
  );

  // The same shared functions the server posts with, so what is shown is what will be posted.
  const preview: Preview = useMemo(() => {
    if (amount === null || amount <= 0) return null;
    if (!manual) return { ok: true, plan: allocateOldestFirst(amount, openInvoices) };
    if (manualRequests.length === 0) return { ok: false, problem: "Enter an amount for at least one invoice." };
    if (manualRequests.some((r) => r.amountCentavos === null)) {
      return { ok: false, problem: "Enter valid peso amounts for the chosen invoices." };
    }
    return planManualAllocation(
      amount,
      manualRequests.map((r) => ({ invoiceId: r.invoiceId, amountCentavos: r.amountCentavos! })),
      openInvoices,
    );
  }, [amount, manual, manualRequests, openInvoices]);

  const applied = new Map(preview?.ok ? preview.plan.lines.map((l) => [l.invoiceId, l.amountCentavos]) : []);
  const archived = context?.subscriber.status === "archived";

  function submit() {
    if (amount === null) return reject({ amountCentavos: "Enter the amount received." });
    if (manual && preview && !preview.ok) return reject({}, preview.problem);
    const parsed = paymentCreateSchema.safeParse({
      subscriberId,
      method,
      amountCentavos: amount,
      paymentDate,
      referenceNumber: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      ...(manual && preview?.ok
        ? { allocations: preview.plan.lines.map((l) => ({ invoiceId: l.invoiceId, amountCentavos: l.amountCentavos })) }
        : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.payments.post(parsed.data));
  }

  if (loadError) {
    return (
      <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
        Could not load the subscriber's balance. {loadError}
      </p>
    );
  }
  if (!context) return <p className="text-muted">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-base font-semibold text-ink">{context.subscriber.fullName}</span>
          <span className="text-muted">{context.subscriber.accountNumber}</span>
          <StatusBadge status={context.subscriber.status} />
        </p>
        <button className="text-sm text-accent hover:underline" onClick={onChangeSubscriber}>
          Change subscriber
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Balance owed" value={formatPesos(Math.max(context.balanceCentavos, 0))} />
        <Tile label="Credit (advance)" value={formatPesos(context.creditCentavos)} />
        <Tile label="Open invoices" value={String(openInvoices.length)} plain />
      </div>

      {archived && (
        <p role="alert" className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          This subscriber is archived and cannot receive payments.
        </p>
      )}

      <div className="flex flex-wrap items-start gap-6">
        <form
          className="w-80 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) submit();
          }}
        >
          <fieldset className="space-y-3" disabled={saving || archived}>
            <MoneyField
              label="Amount received"
              value={amountText}
              onChange={setAmountText}
              required
              error={errors.amountCentavos}
            />
            {totalOpen > 0 && (
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                onClick={() => setAmountText(centavosToInput(totalOpen))}
              >
                Pay full balance ({formatPesos(totalOpen)})
              </button>
            )}
            <SelectField label="Method" value={method} onChange={setMethod} options={COUNTER_METHOD_OPTIONS} required />
            <TextField
              label={method === "cheque" ? "Cheque number" : "Reference number"}
              value={reference}
              onChange={setReference}
              required={method === "cheque" || method === "bank_transfer"}
              error={errors.referenceNumber}
              maxLength={60}
            />
            <DateField
              label="Payment date"
              value={paymentDate}
              onChange={setPaymentDate}
              required
              error={errors.paymentDate}
              hint="Today unless the customer paid earlier."
            />
            <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
          </fieldset>

          {formError && (
            <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={saving || archived || amount === null || amount <= 0 || (preview !== null && !preview.ok)}
            className="w-full rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-50"
          >
            {saving ? "Posting…" : amount !== null && amount > 0 ? `Post payment of ${formatPesos(amount)}` : "Post payment"}
          </button>
          <p className="text-xs text-muted">
            Posted payments cannot be edited. A mistake is corrected by reversing the payment.
          </p>
        </form>

        <section className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              {manual ? "Chosen allocation" : "Allocation preview (oldest first)"}
            </h2>
            {canAllocate && openInvoices.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(e) => {
                    setManual(e.target.checked);
                    setManualAmounts({});
                  }}
                />
                Choose invoices
              </label>
            )}
          </div>

          <div className="overflow-auto rounded-lg border border-slate-200 bg-surface">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-muted">
                  {["Invoice", "Month", "Due", "Status"].map((h) => (
                    <th key={h} scope="col" className="border-b border-slate-200 px-3 py-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                  {["Balance", "Applied", "Remaining"].map((h) => (
                    <th key={h} scope="col" className="border-b border-slate-200 px-3 py-2 text-right font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openInvoices.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted">
                      No open invoices. The whole payment will be kept as credit for future bills.
                    </td>
                  </tr>
                )}
                {openInvoices.map((invoice) => {
                  const pay = applied.get(invoice.id) ?? 0;
                  return (
                    <tr key={invoice.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2">
                        {invoice.invoiceNumber}
                        <span className="block text-xs text-muted">{invoice.serviceNumber}</span>
                      </td>
                      <td className="px-3 py-2">{periodLabel(periodOf(invoice.periodStart))}</td>
                      <td className="px-3 py-2">{invoice.dueDate}</td>
                      <td className="px-3 py-2">
                        <InvoiceStatusBadge status={invoice.displayStatus} />
                      </td>
                      <td className="money px-3 py-2">{formatPesos(invoice.balanceCentavos)}</td>
                      <td className="money px-3 py-2">
                        {manual ? (
                          <input
                            aria-label={`Amount for ${invoice.invoiceNumber}`}
                            className="money w-28 rounded border border-slate-300 px-2 py-1"
                            inputMode="decimal"
                            value={manualAmounts[invoice.id] ?? ""}
                            onChange={(e) => setManualAmounts((m) => ({ ...m, [invoice.id]: e.target.value }))}
                          />
                        ) : pay > 0 ? (
                          formatPesos(pay)
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="money px-3 py-2">{formatPesos(invoice.balanceCentavos - pay)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {preview?.ok && (
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <th scope="row" colSpan={5} className="px-3 py-2 text-left font-medium text-ink">
                      Kept as credit for future bills
                    </th>
                    <td className="money px-3 py-2 font-semibold">{formatPesos(preview.plan.creditCentavos)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {preview && !preview.ok && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {preview.problem}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold text-ink ${plain ? "" : "money text-left"}`}>{value}</div>
    </div>
  );
}

/* ------------------------------ After posting ------------------------------ */

interface PostedPanelProps {
  payment: PaymentDetailDto;
  onAnotherForSame: () => void;
  onNewSubscriber: () => void;
}

function PostedPanel({ payment, onAnotherForSame, onNewSubscriber }: PostedPanelProps) {
  // The first print is the original; any print after that is labelled REPRINT.
  const [printed, setPrinted] = useState(0);

  return (
    <div className="space-y-4">
      <p aria-live="polite" className="rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
        Payment posted as {payment.receiptNumber}: {formatPesos(payment.amountCentavos)} from {payment.subscriberName}.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90"
          onClick={() => {
            window.print();
            setPrinted((n) => n + 1);
          }}
        >
          {printed === 0 ? "Print receipt" : "Print again (reprint)"}
        </button>
        <button className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-slate-50" onClick={onAnotherForSame}>
          Another payment for this subscriber
        </button>
        <button className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-slate-50" onClick={onNewSubscriber}>
          New subscriber
        </button>
      </div>
      <Receipt payment={payment} reprint={printed > 0} />
    </div>
  );
}
