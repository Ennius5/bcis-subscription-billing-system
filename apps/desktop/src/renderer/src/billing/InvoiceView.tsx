import { useEffect, useState } from "react";
import { formatPesos, invoiceVoidSchema, periodLabel, periodOf } from "@bcis/shared";
import type { InvoiceDetailDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { ActionButton, Field, formatDateTime, Section } from "../subscribers/ProfileParts";
import { DataTable } from "../ui/DataTable";
import { TextField } from "../ui/TextField";
import { InvoiceStatusBadge } from "./invoiceStatus";

interface InvoiceViewProps {
  invoiceId: string;
  canVoid: boolean;
  backLabel: string;
  onBack: () => void;
  onSessionExpired: () => void;
}

export function InvoiceView({ invoiceId, canVoid, backLabel, onBack, onSessionExpired }: InvoiceViewProps) {
  const [invoice, setInvoice] = useState<InvoiceDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

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

  // Mirrors the server: drafts are discarded, not voided; a void is final; paid money must be reversed first.
  const voidable =
    canVoid && invoice !== null && invoice.status !== "draft" && invoice.status !== "void" && invoice.paidCentavos === 0;

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
            {voidable && !voiding && <ActionButton label="Void invoice" onClick={() => setVoiding(true)} />}
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

          {voiding && (
            <VoidForm
              invoice={invoice}
              onSaved={(updated) => {
                setInvoice(updated);
                setVoiding(false);
              }}
              onCancel={() => setVoiding(false)}
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
                <dt className="text-muted">Total</dt>
                <dd className="money font-semibold">{formatPesos(invoice.totalCentavos)}</dd>
              </div>
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
        </div>
      )}
    </div>
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
