import { useEffect, useState } from "react";
import { BILLING_DAY_MAX, BILLING_DAY_MIN, formatPesos } from "@bcis/shared";
import type { SubscriberDto } from "../../../preload/index";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm, TextAreaField } from "./ProfileForm";
import { serviceTypeLabel } from "./status";

const DEFAULT_COLLECTOR = "";

interface AddServiceFormProps {
  subscriber: SubscriberDto;
  onSaved: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function AddServiceForm({ subscriber, onSaved, onCancel, onExpired }: AddServiceFormProps) {
  // Only active addresses can host a service; the primary is listed (and chosen) first.
  const addresses = subscriber.addresses.filter((a) => a.isActive);
  const addressOptions: SelectOption[] = addresses.map((a) => ({
    value: a.id,
    label: `${a.line1}, ${a.barangay}, ${a.city}${a.isPrimary ? " (primary)" : ""}`,
  }));

  const [planId, setPlanId] = useState("");
  const [addressId, setAddressId] = useState(addresses[0]?.id ?? "");
  const [billingDay, setBillingDay] = useState(String(subscriber.billingDay));
  const [collectorId, setCollectorId] = useState(DEFAULT_COLLECTOR);
  const [notes, setNotes] = useState("");

  const [planOptions, setPlanOptions] = useState<SelectOption[] | null>(null);
  const [collectorOptions, setCollectorOptions] = useState<SelectOption[] | null>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.bcis.plans.list(false).then((r) => {
      if (r.ok) {
        setPlanOptions([
          { value: "", label: "Choose a plan…" },
          ...r.data.map((p) => ({
            value: p.id,
            label: `${serviceTypeLabel(p.serviceType)} · ${p.code} – ${p.name} (${formatPesos(p.priceCentavos)}/month)`,
          })),
        ]);
      } else if (r.code === "UNAUTHENTICATED") {
        onExpired();
      } else {
        setFormError(`Could not load plans. ${r.message}`);
      }
    });
    // The override is optional; without collection.view the field is simply left out.
    void window.bcis.collectors.list(false).then((r) => {
      if (r.ok) {
        setCollectorOptions([
          {
            value: DEFAULT_COLLECTOR,
            label: subscriber.collectorCode
              ? `Subscriber's collector (${subscriber.collectorCode} – ${subscriber.collectorName})`
              : "Subscriber's collector (none assigned)",
          },
          ...r.data.map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}` })),
        ]);
      }
    });
  }, [subscriber.collectorCode, subscriber.collectorName, onExpired]);

  async function save() {
    const errs: Record<string, string> = {};
    const day = Number(billingDay);
    if (!planId) errs.planId = "Choose a plan.";
    if (!addressId) errs.installationAddressId = "Choose the installation address.";
    if (!/^\d+$/.test(billingDay.trim()) || day < BILLING_DAY_MIN || day > BILLING_DAY_MAX) {
      errs.billingDay = `Billing day must be between ${BILLING_DAY_MIN} and ${BILLING_DAY_MAX}.`;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setFormError(null);
    const result = await window.bcis.serviceAccounts.create(subscriber.id, {
      planId,
      installationAddressId: addressId,
      billingDay: day,
      assignedCollectorId: collectorId === DEFAULT_COLLECTOR ? null : collectorId,
      notes: notes.trim() === "" ? null : notes.trim(),
    });
    if (result.ok) return onSaved();
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  return (
    <ProfileForm
      title="Add service account"
      submitLabel="Add service"
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      {!planOptions ? (
        !formError && <p className="text-sm text-muted">Loading plans…</p>
      ) : (
        <>
          <SelectField label="Plan" value={planId} onChange={setPlanId} options={planOptions} required error={errors.planId} />
          <p className="text-xs text-muted">
            The service is created as Pending at the plan's current price. Activate it once installed.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <SelectField
                label="Installation address"
                value={addressId}
                onChange={setAddressId}
                options={addressOptions}
                required
                error={errors.installationAddressId}
              />
            </div>
            <TextField
              label="Billing day"
              value={billingDay}
              onChange={setBillingDay}
              required
              inputMode="numeric"
              error={errors.billingDay}
              hint="Defaults to the subscriber's"
              maxLength={2}
            />
          </div>
          {collectorOptions && (
            <SelectField
              label="Collector"
              value={collectorId}
              onChange={setCollectorId}
              options={collectorOptions}
              error={errors.assignedCollectorId}
            />
          )}
          <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={1000} />
        </>
      )}
    </ProfileForm>
  );
}
