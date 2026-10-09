import { useState } from "react";
import { gcashSubmissionCreateSchema, tryParsePesos } from "@bcis/shared";
import type { GcashSubmissionDto, GlobalSearchHitDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { DateField } from "../ui/DateField";
import { MoneyField } from "../ui/MoneyField";
import { TextField } from "../ui/TextField";
import { todayLocal } from "./paymentLabels";
import { SubscriberPicker } from "./SubscriberPicker";

interface RecordGcashFormProps {
  onCreated: (submission: GcashSubmissionDto) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
}

/**
 * Spec 3.7 step 2: staff type in what the customer sent on Facebook. Nothing is posted; the
 * submission waits in the queue until someone verifies it against the GCash history.
 */
export function RecordGcashForm({ onCreated, onCancel, onSessionExpired }: RecordGcashFormProps) {
  const [subscriber, setSubscriber] = useState<GlobalSearchHitDto | null>(null);
  const [reference, setReference] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderNumber, setSenderNumber] = useState("");
  const [amountText, setAmountText] = useState("");
  const [transactionDate, setTransactionDate] = useState(todayLocal());
  const [notes, setNotes] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onCreated, onSessionExpired);

  if (!subscriber) {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-navy">Record GCash payment</h2>
        <p className="text-sm text-muted">First find the subscriber the payment is for.</p>
        <SubscriberPicker onPick={setSubscriber} onSessionExpired={onSessionExpired} />
        <button className="text-sm text-accent hover:underline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  function submit() {
    const amount = tryParsePesos(amountText);
    if (amount === null) return reject({ amountCentavos: "Enter the amount sent." });
    const parsed = gcashSubmissionCreateSchema.safeParse({
      subscriberId: subscriber!.id,
      referenceNumber: reference,
      senderName,
      senderNumber,
      amountCentavos: amount,
      transactionDate,
      notes: notes.trim() || undefined,
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.gcash.create(parsed.data));
  }

  return (
    <ProfileForm
      title={`Record GCash payment for ${subscriber.fullName} (${subscriber.accountNumber})`}
      submitLabel="Record submission"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted">
        Copy the details from the customer's message. You attach the screenshot next; nothing is posted until it is
        verified.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="GCash reference no."
          value={reference}
          onChange={setReference}
          required
          error={errors.referenceNumber}
          hint="Spaces are ignored."
          maxLength={40}
        />
        <MoneyField label="Amount" value={amountText} onChange={setAmountText} required error={errors.amountCentavos} />
        <TextField label="Sender name" value={senderName} onChange={setSenderName} required error={errors.senderName} maxLength={120} />
        <TextField
          label="Sender mobile no."
          value={senderNumber}
          onChange={setSenderNumber}
          required
          error={errors.senderNumber}
          maxLength={30}
        />
        <DateField
          label="Transaction date"
          value={transactionDate}
          onChange={setTransactionDate}
          required
          error={errors.transactionDate}
          hint="As shown on the GCash receipt."
        />
      </div>
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
    </ProfileForm>
  );
}
