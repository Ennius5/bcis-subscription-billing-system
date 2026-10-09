import { useEffect, useState } from "react";
import { BILLING_DAY_MAX, BILLING_DAY_MIN, serviceAccountUpdateSchema } from "@bcis/shared";
import type { ServiceAccountDetailDto } from "../../../preload/index";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { ProfileForm, schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { useSave } from "./useSave";

interface ServiceEditFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ServiceEditForm({ account, onSaved, onCancel, onExpired }: ServiceEditFormProps) {
  const [addressId, setAddressId] = useState(account.installationAddressId);
  const [billingDay, setBillingDay] = useState(String(account.billingDay));
  const [notes, setNotes] = useState(account.notes ?? "");
  const [reason, setReason] = useState("");
  // null until loaded; stays null without subscriber.view, which hides the address picker.
  const [addressOptions, setAddressOptions] = useState<SelectOption[] | null>(null);
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  // The subscriber's active addresses, plus the current one so the picker shows the truth.
  useEffect(() => {
    void window.bcis.subscribers.get(account.subscriberId).then((r) => {
      if (r.ok) {
        setAddressOptions(
          r.data.addresses
            .filter((a) => a.isActive || a.id === account.installationAddressId)
            .map((a) => ({
              value: a.id,
              label: `${a.line1}, ${a.barangay}, ${a.city}${a.isPrimary ? " (primary)" : ""}${a.isActive ? "" : " (inactive)"}`,
            })),
        );
      } else if (r.code === "UNAUTHENTICATED") {
        onExpired();
      }
    });
  }, [account.subscriberId, account.installationAddressId, onExpired]);

  function submit() {
    const day = Number(billingDay);
    if (!/^\d+$/.test(billingDay.trim()) || day < BILLING_DAY_MIN || day > BILLING_DAY_MAX) {
      return reject({ billingDay: `Billing day must be between ${BILLING_DAY_MIN} and ${BILLING_DAY_MAX}.` });
    }

    // Send only what changed, so the history shows a clean before and after.
    const notesValue = notes.trim() === "" ? null : notes.trim();
    const changes: Record<string, unknown> = {};
    if (addressId !== account.installationAddressId) changes.installationAddressId = addressId;
    if (day !== account.billingDay) changes.billingDay = day;
    if (notesValue !== account.notes) changes.notes = notesValue;
    if (Object.keys(changes).length === 0) return reject({}, "No changes to save.");
    if (reason.trim() !== "") changes.reason = reason;

    const parsed = serviceAccountUpdateSchema.safeParse(changes);
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceAccounts.update(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Edit service details"
      submitLabel="Save changes"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          {addressOptions ? (
            <SelectField
              label="Installation address"
              value={addressId}
              onChange={setAddressId}
              options={addressOptions}
              required
              error={errors.installationAddressId}
            />
          ) : (
            <p className="text-sm text-muted">
              Installation address: {account.addressLine1}, {account.addressBarangay}, {account.addressCity}
            </p>
          )}
        </div>
        <TextField
          label="Billing day"
          value={billingDay}
          onChange={setBillingDay}
          required
          inputMode="numeric"
          error={errors.billingDay}
          maxLength={2}
        />
      </div>
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={1000} />
      <TextField
        label="Reason for change"
        value={reason}
        onChange={setReason}
        error={errors.reason}
        hint="Optional. Recorded in the service history."
        maxLength={200}
      />
    </ProfileForm>
  );
}
