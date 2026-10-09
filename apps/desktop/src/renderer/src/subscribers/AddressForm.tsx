import { useState } from "react";
import type { SubscriberAddressDto, SubscriberDto } from "../../../preload/index";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm } from "./ProfileForm";

interface AddressFormProps {
  subscriber: SubscriberDto;
  /** null adds a new address. */
  address: SubscriberAddressDto | null;
  onSaved: (updated: SubscriberDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

export function AddressForm({ subscriber, address, onSaved, onCancel, onExpired }: AddressFormProps) {
  const [label, setLabel] = useState(address?.label ?? "");
  const [line1, setLine1] = useState(address?.line1 ?? "");
  const [barangay, setBarangay] = useState(address?.barangay ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [province, setProvince] = useState(address?.province ?? "");
  const [landmark, setLandmark] = useState(address?.landmark ?? "");
  const [isPrimary, setIsPrimary] = useState(false);
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const errs: Record<string, string> = {};
    if (!line1.trim()) errs.line1 = "Street or purok is required.";
    if (!barangay.trim()) errs.barangay = "Barangay is required.";
    if (!city.trim()) errs.city = "City or municipality is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const values = {
      label: blankToNull(label),
      line1: line1.trim(),
      barangay: barangay.trim(),
      city: city.trim(),
      province: blankToNull(province),
      landmark: blankToNull(landmark),
    };

    let request;
    if (address) {
      // Send only what changed, so the audit trail shows a clean before and after.
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value !== address[key as keyof typeof values]) changes[key] = value;
      }
      if (Object.keys(changes).length === 0) {
        setFormError("No changes to save.");
        return;
      }
      if (reason.trim() !== "") changes.reason = reason.trim();
      request = window.bcis.subscribers.updateAddress(subscriber.id, address.id, changes);
    } else {
      request = window.bcis.subscribers.addAddress(subscriber.id, { ...values, isPrimary });
    }

    setSaving(true);
    setFormError(null);
    const result = await request;
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  return (
    <ProfileForm
      title={address ? "Edit address" : "Add address"}
      submitLabel={address ? "Save changes" : "Add address"}
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <TextField label="Label" value={label} onChange={setLabel} error={errors.label} hint="e.g. Home, Shop" maxLength={50} />
        <div className="col-span-2">
          <TextField label="Street or purok" value={line1} onChange={setLine1} required error={errors.line1} maxLength={200} />
        </div>
        <TextField label="Barangay" value={barangay} onChange={setBarangay} required error={errors.barangay} maxLength={100} />
        <TextField label="City or municipality" value={city} onChange={setCity} required error={errors.city} maxLength={100} />
        <TextField label="Province" value={province} onChange={setProvince} error={errors.province} maxLength={100} />
        <div className="col-span-3">
          <TextField label="Landmark" value={landmark} onChange={setLandmark} error={errors.landmark} maxLength={200} />
        </div>
      </div>
      {address ? (
        <TextField label="Reason for change" value={reason} onChange={setReason} error={errors.reason} hint="Optional. Recorded in the history." maxLength={200} />
      ) : (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Make this the primary service address (replaces the current primary)
        </label>
      )}
    </ProfileForm>
  );
}
