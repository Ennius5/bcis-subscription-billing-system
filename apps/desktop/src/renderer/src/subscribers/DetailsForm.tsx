import { useState } from "react";
import { BILLING_DAY_MAX, BILLING_DAY_MIN } from "@bcis/shared";
import type { SubscriberDto } from "../../../preload/index";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm, TextAreaField } from "./ProfileForm";

interface DetailsFormProps {
  subscriber: SubscriberDto;
  onSaved: (updated: SubscriberDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function DetailsForm({ subscriber, onSaved, onCancel, onExpired }: DetailsFormProps) {
  const [fullName, setFullName] = useState(subscriber.fullName);
  const [billingDay, setBillingDay] = useState(String(subscriber.billingDay));
  const [notes, setNotes] = useState(subscriber.notes ?? "");
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const errs: Record<string, string> = {};
    const day = Number(billingDay);
    if (!fullName.trim()) errs.fullName = "Full name is required.";
    if (!/^\d+$/.test(billingDay.trim()) || day < BILLING_DAY_MIN || day > BILLING_DAY_MAX) {
      errs.billingDay = `Billing day must be between ${BILLING_DAY_MIN} and ${BILLING_DAY_MAX}.`;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // Send only what changed, so the audit trail shows a clean before and after.
    const notesValue = notes.trim() === "" ? null : notes.trim();
    const changes: Record<string, unknown> = {};
    if (fullName.trim() !== subscriber.fullName) changes.fullName = fullName.trim();
    if (day !== subscriber.billingDay) changes.billingDay = day;
    if (notesValue !== subscriber.notes) changes.notes = notesValue;
    if (Object.keys(changes).length === 0) {
      setFormError("No changes to save.");
      return;
    }
    if (reason.trim() !== "") changes.reason = reason.trim();

    setSaving(true);
    setFormError(null);
    const result = await window.bcis.subscribers.update(subscriber.id, changes);
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  return (
    <ProfileForm
      title="Edit details"
      submitLabel="Save changes"
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <TextField label="Full name" value={fullName} onChange={setFullName} required error={errors.fullName} maxLength={150} />
        </div>
        <TextField
          label="Billing day"
          value={billingDay}
          onChange={setBillingDay}
          required
          inputMode="numeric"
          error={errors.billingDay}
          hint={`${BILLING_DAY_MIN} to ${BILLING_DAY_MAX}`}
          maxLength={2}
        />
      </div>
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={1000} />
      <TextField label="Reason for change" value={reason} onChange={setReason} error={errors.reason} hint="Optional. Recorded in the history." maxLength={200} />
    </ProfileForm>
  );
}
