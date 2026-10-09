import { useEffect, useState } from "react";
import {
  ADJUSTMENT_CATEGORY_LABELS,
  adjustmentCreateSchema,
  adjustmentProblem,
  categoriesFor,
  formatPesos,
  invoiceVoidSchema,
  periodLabel,
  periodOf,
  tryParsePesos,
  type AdjustmentCategory,
  type AdjustmentKind,
} from "@bcis/shared";
import type { InvoiceDetailDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { ActionButton, Field, formatDateTime, Section } from "../subscribers/ProfileParts";
import { DataTable } from "../ui/DataTable";
import { MoneyField } from "../ui/MoneyField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { InvoiceStatusBadge } from "./invoiceStatus";

interface InvoiceViewProps {
  invoiceId: string;
  canVoid: boolean;
  canAdjust: boolean;
  backLabel: string;
  onBack: () => void;
  onSessionExpired: () => void;
}

export function InvoiceView({ invoiceId, canVoid, canAdjust, backLabel, onBack, onSessionExpired }: InvoiceViewProps) {
  const [invoice, setInvoice] = useState<InvoiceDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<"void" | "adjust" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.billing.getInvoice(invoiceId).then((r) => {
      if (cancelled) return;
      if (r.ok) setInvoice(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [invoiceId, onSessionExpired]);

  const finalized = invoice !== null && invoice.status !== "draft" && invoice.status !== "void";
  // Mirrors the server: drafts are discarded, not voided; a void is final; payments must be
  // reversed and adjustments offset first.
  const voidable = canVoid && finalized && invoice.paidCentavos === 0 && invoice.adjustments.length === 0;
  const adjustable = canAdjust && finalized;

  return (
    <div>
      <button className="mb-4 text-sm text-accent hover:underline" onClick={onBack}>
        ← {backLabel}
      </button>

      {loadError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the invoice. {loadError}
        </p>
      )}
      {!invoice && !loadError && <p className="text-muted">Loading…</p>}

      {invoice && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold text-navy">
                {invoice.invoiceNumber ?? "Draft invoice"}
                <span className="font-normal text-muted">{periodLabel(periodOf(invoice.periodStart))}</span>
                <InvoiceStatusBadge status={invoice.displayStatus} />
              </h1>
              <p className="mt-1 text-sm text-muted">
                {invoice.subscriberName} · {invoice.accountNumber} · {invoice.serviceNumber} ({invoice.planName})
              </p>
            </div>
            {form === null && (
              <div className="flex gap-2">
                {adjustable && <ActionButton label="Adjust" onClick={() => setForm("adjust")} />}
                {voidable && <ActionButton label="Void invoice" onClick={() => setForm("void")} />}
              </div>
            )}
          </div>

          {invoice.status === "draft" && (
            <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
              This is a draft. It has no number and is not on the subscriber's ledger until the month is finalized.
            </p>
          )}
          {invoice.status === "void" && (
            <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
              Voided{invoice.voidedAt ? ` on ${formatDateTime(invoice.voidedAt)}` : ""}. Reason: {invoice.voidReason}. The
              ledger carries a matching credit; the invoice number stays reserved.
            </p>
          )}

          {invoice.status === "credited" && (
            <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
              Credited in full by adjustment. Nothing is owed on this invoice.
            </p>
          )}

          {form === "void" && (
            <VoidForm
              invoice={invoice}
              onSaved={(updated) => {
                setInvoice(updated);
                setForm(null);
              }}
              onCancel={() => setForm(null)}
              onExpired={onSessionExpired}
            />
          )}
          {form === "adjust" && (
            <AdjustForm
              invoice={invoice}
              onSaved={(updated) => {
                setInvoice(updated);
                setForm(null);
              }}
              onCancel={() => setForm(null)}
              onExpired={onSessionExpired}
            />
          )}

          <Section title="Invoice">
            <dl className="grid grid-cols-4 gap-3">
              <Field label="Invoice date">{invoice.invoiceDate}</Field>
              <Field label="Due date">{invoice.dueDate}</Field>
              <Field label="Billing period">
                {invoice.periodStart} to {invoice.periodEnd}
              </Field>
              <Field label="Finalized">{invoice.finalizedAt ? formatDateTime(invoice.finalizedAt) : "Not yet"}</Field>
            </dl>
          </Section>

          <Section title="Charges">
            <DataTable
              columns={[
                { key: "line", header: "#", render: (l) => l.lineNo },
                { key: "description", header: "Description", render: (l) => l.description },
                {
                  key: "rate",
                  header: "Rate",
                  align: "right",
                  render: (l) => (l.rateCentavos === null ? "" : formatPesos(l.rateCentavos)),
                },
                { key: "amount", header: "Amount", align: "right", render: (l) => formatPesos(l.amountCentavos) },
              ]}
              rows={invoice.items}
              getRowKey={(l) => String(l.lineNo)}
              emptyMessage="No charges."
            />
            <dl className="mt-3 ml-auto w-64 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Total billed</dt>
                <dd className="money font-semibold">{formatPesos(invoice.totalCentavos)}</dd>
              </div>
              {invoice.adjustedCentavos !== 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Adjustments</dt>
                  <dd className="money">
                    {invoice.adjustedCentavos > 0 ? "+" : ""}
                    {formatPesos(invoice.adjustedCentavos)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted">Paid</dt>
                <dd className="money">{formatPesos(invoice.paidCentavos)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <dt className="text-muted">Balance</dt>
                <dd className="money font-semibold">{formatPesos(invoice.balanceCentavos)}</dd>
              </div>
            </dl>
          </Section>

          {invoice.adjustments.length > 0 && (
            <Section title="Adjustments">
              <DataTable
                columns={[
                  { key: "number", header: "No.", render: (a) => a.adjustmentNumber },
                  { key: "date", header: "Posted", render: (a) => formatDateTime(a.createdAt) },
                  { key: "kind", header: "Kind", render: (a) => (a.kind === "credit" ? "Credit" : "Debit") },
                  {
                    key: "category",
                    header: "Category",
                    render: (a) => ADJUSTMENT_CATEGORY_LABELS[a.category as AdjustmentCategory] ?? a.category,
                  },
                  {
                    key: "reason",
                    header: "Reason",
                    render: (a) => (
                      <>
                        {a.reason}
                        <span className="block text-xs text-muted">by {a.createdByName}</span>
                      </>
                    ),
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    render: (a) => (a.kind === "credit" ? "−" : "+") + formatPesos(a.amountCentavos),
                  },
                ]}
                rows={invoice.adjustments}
                getRowKey={(a) => a.id}
                emptyMessage="No adjustments."
              />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

interface AdjustFormProps {
  invoice: InvoiceDetailDto;
  onSaved: (updated: InvoiceDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

const KIND_OPTIONS = [
  { value: "credit", label: "Credit (lower what is owed)" },
  { value: "debit", label: "Debit (add a charge)" },
];

function AdjustForm({ invoice, onSaved, onCancel, onExpired }: AdjustFormProps) {
  const [kind, setKind] = useState<AdjustmentKind>("credit");
  const [category, setCategory] = useState<string>(categoriesFor("credit")[0]!);
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  const amount = tryParsePesos(amountText);
  const balanceAfter =
    amount !== null && amount > 0 ? invoice.balanceCentavos + (kind === "debit" ? amount : -amount) : null;

  function submit() {
    if (amount === null) return reject({ amountCentavos: "Enter the amount." });
    const parsed = adjustmentCreateSchema.safeParse({ kind, category, amountCentavos: amount, reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    // The same rule the server applies, so it shows before anything is sent.
    const problem = adjustmentProblem(parsed.data.kind, parsed.data.amountCentavos, invoice.balanceCentavos);
    if (problem) return reject({ amountCentavos: problem });
    void save(() => window.bcis.billing.adjustInvoice(invoice.id, parsed.data));
  }

  return (
    <ProfileForm
      title={`Adjust ${invoice.invoiceNumber}`}
      submitLabel={kind === "credit" ? "Post credit" : "Post debit"}
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Kind"
          value={kind}
          onChange={(value) => {
            const next = value === "debit" ? "debit" : "credit";
            setKind(next);
            setCategory(categoriesFor(next)[0]!);
          }}
          options={KIND_OPTIONS}
          required
        />
        <SelectField
          label="Category"
          value={category}
          onChange={setCategory}
          options={categoriesFor(kind).map((c) => ({ value: c, label: ADJUSTMENT_CATEGORY_LABELS[c] }))}
          required
          error={errors.category}
        />
        <MoneyField label="Amount" value={amountText} onChange={setAmountText} required error={errors.amountCentavos} />
        <p className="self-end pb-2 text-sm text-muted">
          {kind === "credit" ? `At most the open balance, ${formatPesos(invoice.balanceCentavos)}.` : "No limit."}
          {balanceAfter !== null && balanceAfter >= 0 && (
            <span className="block">
              Balance after: <span className="money font-medium text-ink">{formatPesos(balanceAfter)}</span>
            </span>
          )}
        </p>
      </div>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Shown on the invoice, the ledger and the audit log. To correct an adjustment, post the opposite one and name it here."
        maxLength={200}
      />
    </ProfileForm>
  );
}

interface VoidFormProps {
  invoice: InvoiceDetailDto;
  onSaved: (updated: InvoiceDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function VoidForm({ invoice, onSaved, onCancel, onExpired }: VoidFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = invoiceVoidSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.billing.voidInvoice(invoice.id, parsed.data.reason));
  }

  return (
    <ProfileForm
      title={`Void ${invoice.invoiceNumber}`}
      submitLabel="Void invoice"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
        Voiding is final. The invoice stays on record with its number, the ledger gets a credit of{" "}
        {formatPesos(invoice.totalCentavos)}, and the month can be billed again.
      </p>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the audit log."
        maxLength={200}
      />
    </ProfileForm>
  );
}
