import { useState } from "react";
import { fieldCollectionCreateSchema, formatPesos, tryParsePesos } from "@bcis/shared";
import type { BatchCollectionDto, BatchDetailDto, PaymentDetailDto } from "../../../preload/index";
import { methodLabel, PaymentStatusBadge } from "../payments/paymentLabels";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { ActionButton, formatDateTime, Section } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { centavosToInput, MoneyField } from "../ui/MoneyField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";

interface CollectionsSectionProps {
  batch: BatchDetailDto;
  canRecord: boolean;
  /** Fetch the batch again: a posted collection changes its totals. */
  onReload: () => void;
  onSessionExpired: () => void;
}

/**
 * The field collections on a batch: every one stays listed, reversed ones too. While the
 * batch is in progress, collections are typed in from the collector's tally; each one is a
 * real payment with its own receipt number, posted to the subscriber's ledger straight away.
 */
export function CollectionsSection({ batch, canRecord, onReload, onSessionExpired }: CollectionsSectionProps) {
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const showForm = canRecord && batch.status === "in_progress" && recording;

  const columns: Column<BatchCollectionDto>[] = [
    { key: "receipt", header: "Receipt no.", render: (c) => <span className="font-medium">{c.receiptNumber}</span> },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (c) => (
        <>
          {c.fullName}
          <span className="block text-xs text-muted">{c.accountNumber}</span>
        </>
      ),
    },
    {
      key: "method",
      header: "Method",
      render: (c) => (
        <>
          {methodLabel(c.method)}
          {c.referenceNumber && <span className="block text-xs text-muted">{c.referenceNumber}</span>}
        </>
      ),
    },
    { key: "date", header: "Paid on", render: (c) => c.paymentDate },
    {
      key: "by",
      header: "Entered by",
      render: (c) => (
        <>
          {c.receivedByName}
          <span className="block text-xs text-muted">{formatDateTime(c.postedAt)}</span>
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (c) => (
        <>
          <PaymentStatusBadge status={c.status} />
          {c.reversalReason && <span className="block text-xs text-muted">{c.reversalReason}</span>}
        </>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (c) => (
        <span className={c.status === "reversed" ? "text-muted line-through" : ""}>{formatPesos(c.amountCentavos)}</span>
      ),
    },
  ];

  return (
    <Section
      title="Collections"
      action={
        canRecord &&
        batch.status === "in_progress" &&
        !recording && <ActionButton label="Record collection" onClick={() => setRecording(true)} />
      }
    >
      {notice && (
        <p aria-live="polite" className="mb-3 rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      )}
      {showForm && (
        <RecordCollectionForm
          batch={batch}
          onPosted={(payment) => {
            setNotice(
              `${payment.receiptNumber} posted: ${formatPesos(payment.amountCentavos)} from ${payment.accountNumber} ${payment.subscriberName}.` +
                (payment.creditCentavos > 0 ? ` ${formatPesos(payment.creditCentavos)} is kept as credit.` : ""),
            );
            onReload();
          }}
          onClose={() => setRecording(false)}
          onSessionExpired={onSessionExpired}
        />
      )}
      <DataTable
        columns={columns}
        rows={batch.collections}
        getRowKey={(c) => c.paymentId}
        emptyMessage={
          batch.status === "in_progress" ? "No collections recorded yet." : "No collections were recorded on this batch."
        }
      />
    </Section>
  );
}

interface RecordCollectionFormProps {
  batch: BatchDetailDto;
  onPosted: (payment: PaymentDetailDto) => void;
  onClose: () => void;
  onSessionExpired: () => void;
}

function RecordCollectionForm({ batch, onPosted, onClose, onSessionExpired }: RecordCollectionFormProps) {
  const [subscriberId, setSubscriberId] = useState("");
  const [method, setMethod] = useState<"cash" | "cheque">("cash");
  const [amountText, setAmountText] = useState("");
  const [paymentDate, setPaymentDate] = useState(batch.collectionDate);
  const [referenceNumber, setReferenceNumber] = useState("");
  // The form stays open for the next stop: clear who and how much, keep method and date.
  const { errors, formError, saving, reject, save } = useSave<PaymentDetailDto>((payment) => {
    setSubscriberId("");
    setAmountText("");
    setReferenceNumber("");
    onPosted(payment);
  }, onSessionExpired);

  function pick(id: string) {
    setSubscriberId(id);
    // Start from what is still due on the route sheet; the collector's tally may differ.
    const account = batch.accounts.find((a) => a.subscriberId === id);
    const left = account ? account.totalDueCentavos - account.collectedCentavos : 0;
    setAmountText(left > 0 ? centavosToInput(left) : "");
  }

  function submit() {
    const amountCentavos = tryParsePesos(amountText);
    if (amountCentavos === null) return reject({ amountCentavos: "Enter a valid peso amount, for example 999.00." });
    const parsed = fieldCollectionCreateSchema.safeParse({
      subscriberId,
      method,
      amountCentavos,
      paymentDate,
      referenceNumber: referenceNumber.trim() || null,
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.batches.recordCollection(batch.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Record a collection from the collector's tally"
      submitLabel="Post collection"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onClose}
    >
      <div className="grid grid-cols-6 gap-3">
        <div className="col-span-3">
          <SelectField
            label="Subscriber on this batch"
            value={subscriberId}
            onChange={pick}
            required
            error={errors.subscriberId}
            options={[
              { value: "", label: "Choose a subscriber" },
              ...batch.accounts.map((a) => ({
                value: a.subscriberId,
                label: `${a.accountNumber} · ${a.fullName} · due ${formatPesos(a.totalDueCentavos)}${
                  a.collectedCentavos > 0 ? `, ${formatPesos(a.collectedCentavos)} collected` : ""
                }`,
              })),
            ]}
          />
        </div>
        <SelectField
          label="Method"
          value={method}
          onChange={(v) => setMethod(v === "cheque" ? "cheque" : "cash")}
          required
          options={[
            { value: "cash", label: "Cash" },
            { value: "cheque", label: "Cheque" },
          ]}
        />
        <MoneyField label="Amount" value={amountText} onChange={setAmountText} required error={errors.amountCentavos} />
        <DateField label="Paid on" value={paymentDate} onChange={setPaymentDate} required error={errors.paymentDate} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={method === "cheque" ? "Cheque no." : "Collector's receipt no."}
          value={referenceNumber}
          onChange={setReferenceNumber}
          required={method === "cheque"}
          error={errors.referenceNumber}
          hint={method === "cheque" ? undefined : "Optional: the number on the collector's paper receipt."}
          maxLength={60}
        />
      </div>
      <p className="text-xs text-muted">
        Posting pays the subscriber's oldest bills first and prints nothing; anything over what they owe stays as credit.
        A mistake is corrected by reversing the receipt in Payment History.
      </p>
    </ProfileForm>
  );
}
