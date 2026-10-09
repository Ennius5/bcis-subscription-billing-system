import { useEffect, useState } from "react";
import { formatPesos, paymentReverseSchema } from "@bcis/shared";
import type { PaymentDetailDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { ActionButton } from "../subscribers/ProfileParts";
import { TextField } from "../ui/TextField";
import { PaymentStatusBadge } from "./paymentLabels";
import { Receipt } from "./Receipt";

interface PaymentViewProps {
  paymentId: string;
  canReverse: boolean;
  onBack: () => void;
  onSessionExpired: () => void;
}

/** One payment from Payment History: its receipt (printed as a REPRINT) and, if allowed, reversal. */
export function PaymentView({ paymentId, canReverse, onBack, onSessionExpired }: PaymentViewProps) {
  const [payment, setPayment] = useState<PaymentDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.payments.get(paymentId).then((r) => {
      if (cancelled) return;
      if (r.ok) setPayment(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [paymentId, onSessionExpired]);

  return (
    <div>
      <button className="mb-4 text-sm text-accent hover:underline" onClick={onBack}>
        ← Back to payment history
      </button>

      {loadError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the payment. {loadError}
        </p>
      )}
      {!payment && !loadError && <p className="text-muted">Loading…</p>}

      {payment && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="flex items-center gap-3 text-xl font-semibold text-navy">
              {payment.receiptNumber}
              <PaymentStatusBadge status={payment.status} />
            </h1>
            <div className="flex gap-2">
              <ActionButton label="Print receipt (reprint)" onClick={() => window.print()} />
              {canReverse && payment.status === "posted" && !reversing && (
                <ActionButton label="Reverse payment" onClick={() => setReversing(true)} />
              )}
            </div>
          </div>

          {notice && (
            <p aria-live="polite" className="rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
              {notice}
            </p>
          )}

          {reversing && (
            <ReverseForm
              payment={payment}
              onSaved={(updated) => {
                setPayment(updated);
                setReversing(false);
                setNotice(`${updated.receiptNumber} was reversed. The receipt stays on record as void.`);
              }}
              onCancel={() => setReversing(false)}
              onExpired={onSessionExpired}
            />
          )}

          <Receipt payment={payment} reprint />
        </div>
      )}
    </div>
  );
}

interface ReverseFormProps {
  payment: PaymentDetailDto;
  onSaved: (updated: PaymentDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function ReverseForm({ payment, onSaved, onCancel, onExpired }: ReverseFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);
  const invoices = [...new Set(payment.allocations.map((a) => a.invoiceNumber))];

  function submit() {
    const parsed = paymentReverseSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.payments.reverse(payment.id, parsed.data.reason));
  }

  return (
    <ProfileForm
      title={`Reverse ${payment.receiptNumber}`}
      submitLabel="Reverse payment"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
        <p>Reversing is final. The payment and its receipt number stay on record, marked void.</p>
        <ul className="mt-1 list-disc pl-5">
          <li>
            The ledger gets a debit of <span className="money">{formatPesos(payment.amountCentavos)}</span>.
          </li>
          {invoices.length > 0 && <li>These invoices get their balance back: {invoices.join(", ")}.</li>}
          {payment.method === "gcash" && <li>The GCash reference becomes free to record again.</li>}
        </ul>
      </div>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the audit log, e.g. cheque bounced or posted to the wrong subscriber."
        maxLength={200}
      />
    </ProfileForm>
  );
}
