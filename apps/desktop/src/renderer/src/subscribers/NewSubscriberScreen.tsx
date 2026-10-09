import { useEffect, useState, type FormEvent } from "react";
import {
  BILLING_DAY_MAX,
  BILLING_DAY_MIN,
  CONTACT_TYPES,
  contactValueProblem,
  SUBSCRIBER_CONTACTS_MAX,
  type ContactType,
} from "@bcis/shared";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { failureToErrors, TextAreaField } from "./ProfileForm";
import { contactTypeLabel } from "./status";

interface ContactRow {
  /** Local key only, so React keeps rows straight when one is removed. */
  key: number;
  type: string;
  value: string;
  contactName: string;
}

const NONE = "";
const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

interface NewSubscriberScreenProps {
  onCreated: (subscriberId: string) => void;
  onSessionExpired: () => void;
}

export function NewSubscriberScreen({ onCreated, onSessionExpired }: NewSubscriberScreenProps) {
  const [fullName, setFullName] = useState("");
  const [billingDay, setBillingDay] = useState("");
  const [notes, setNotes] = useState("");

  const [label, setLabel] = useState("");
  const [line1, setLine1] = useState("");
  const [barangay, setBarangay] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [landmark, setLandmark] = useState("");

  const [areaId, setAreaId] = useState(NONE);
  const [collectorId, setCollectorId] = useState(NONE);
  const [areaOptions, setAreaOptions] = useState<SelectOption[] | null>(null);
  const [collectorOptions, setCollectorOptions] = useState<SelectOption[] | null>(null);

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [primaryKey, setPrimaryKey] = useState<number | null>(null);
  const [nextKey, setNextKey] = useState(1);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Only active areas and collectors can be assigned. Without collection.view the
  // assignment is simply left out and can be set later from the profile.
  useEffect(() => {
    void window.bcis.collectionAreas.list(false).then((r) => {
      if (r.ok) {
        setAreaOptions([
          { value: NONE, label: "Not assigned" },
          ...r.data.map((a) => ({ value: a.id, label: `${a.code} – ${a.name}` })),
        ]);
      }
    });
    void window.bcis.collectors.list(false).then((r) => {
      if (r.ok) {
        setCollectorOptions([
          { value: NONE, label: "Not assigned" },
          ...r.data.map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}` })),
        ]);
      }
    });
  }, []);

  function addContact() {
    setContacts((rows) => [...rows, { key: nextKey, type: "mobile", value: "", contactName: "" }]);
    // The first contact becomes primary by default; it can be changed before saving.
    if (contacts.length === 0) setPrimaryKey(nextKey);
    setNextKey((k) => k + 1);
  }

  function updateContact(key: number, patch: Partial<ContactRow>) {
    setContacts((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeContact(key: number) {
    setContacts((rows) => rows.filter((row) => row.key !== key));
    if (primaryKey === key) setPrimaryKey(null);
    // Row errors are keyed by position, which just shifted.
    setErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([path]) => !path.startsWith("contacts."))));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    const errs: Record<string, string> = {};
    const day = Number(billingDay);
    if (!fullName.trim()) errs.fullName = "Full name is required.";
    if (!/^\d+$/.test(billingDay.trim()) || day < BILLING_DAY_MIN || day > BILLING_DAY_MAX) {
      errs.billingDay = `Billing day must be between ${BILLING_DAY_MIN} and ${BILLING_DAY_MAX}.`;
    }
    if (!line1.trim()) errs["address.line1"] = "Street or purok is required.";
    if (!barangay.trim()) errs["address.barangay"] = "Barangay is required.";
    if (!city.trim()) errs["address.city"] = "City or municipality is required.";
    contacts.forEach((row, i) => {
      const problem = contactValueProblem(row.type as ContactType, row.value);
      if (problem) errs[`contacts.${i}.value`] = problem;
    });
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      setFormError("Please correct the highlighted fields.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const result = await window.bcis.subscribers.create({
      fullName: fullName.trim(),
      billingDay: day,
      notes: blankToNull(notes),
      collectionAreaId: areaId === NONE ? null : areaId,
      assignedCollectorId: collectorId === NONE ? null : collectorId,
      address: {
        label: blankToNull(label),
        line1: line1.trim(),
        barangay: barangay.trim(),
        city: city.trim(),
        province: blankToNull(province),
        landmark: blankToNull(landmark),
      },
      contacts: contacts.map((row) => ({
        type: row.type,
        value: row.value.trim(),
        contactName: blankToNull(row.contactName),
        isPrimary: row.key === primaryKey,
      })),
    });

    if (result.ok) return onCreated(result.data.id);
    if (result.code === "UNAUTHENTICATED") return onSessionExpired();
    // Server issue paths ("address.line1", "contacts.0.value") match the keys used above.
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form ?? "Please correct the highlighted fields.");
    setSaving(false);
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-navy">New Subscriber</h1>

      <fieldset disabled={saving} className="space-y-6">
        <section className="rounded-lg border border-slate-200 bg-surface p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Subscriber</h2>
          <div className="grid grid-cols-3 gap-4">
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
              hint={`Day of the month, ${BILLING_DAY_MIN} to ${BILLING_DAY_MAX}`}
              maxLength={2}
            />
          </div>
          <p className="mt-2 text-xs text-muted">The account number is assigned automatically when you save.</p>
        </section>

        <section className="rounded-lg border border-slate-200 bg-surface p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Service address</h2>
          <div className="grid grid-cols-3 gap-4">
            <TextField label="Label" value={label} onChange={setLabel} error={errors["address.label"]} hint="e.g. Home" maxLength={50} />
            <div className="col-span-2">
              <TextField label="Street or purok" value={line1} onChange={setLine1} required error={errors["address.line1"]} maxLength={200} />
            </div>
            <TextField label="Barangay" value={barangay} onChange={setBarangay} required error={errors["address.barangay"]} maxLength={100} />
            <TextField label="City or municipality" value={city} onChange={setCity} required error={errors["address.city"]} maxLength={100} />
            <TextField label="Province" value={province} onChange={setProvince} error={errors["address.province"]} maxLength={100} />
            <div className="col-span-3">
              <TextField label="Landmark" value={landmark} onChange={setLandmark} error={errors["address.landmark"]} maxLength={200} />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Contacts ({contacts.length} of {SUBSCRIBER_CONTACTS_MAX})
            </h2>
            {contacts.length < SUBSCRIBER_CONTACTS_MAX && (
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                onClick={addContact}
              >
                Add contact
              </button>
            )}
          </div>
          {errors.contacts && <p role="alert" className="mb-2 text-xs text-danger">{errors.contacts}</p>}
          {contacts.length === 0 ? (
            <p className="text-sm text-muted">No contacts. Contacts are optional and can be added later.</p>
          ) : (
            <div className="space-y-3">
              {contacts.map((row, i) => (
                <div key={row.key} className="grid grid-cols-[8rem_1fr_1fr_auto_auto] items-start gap-3">
                  <SelectField
                    label="Type"
                    value={row.type}
                    onChange={(type) => updateContact(row.key, { type })}
                    options={CONTACT_TYPES.map((t) => ({ value: t, label: contactTypeLabel(t) }))}
                  />
                  <TextField
                    label="Value"
                    value={row.value}
                    onChange={(value) => updateContact(row.key, { value })}
                    required
                    error={errors[`contacts.${i}.value`]}
                    maxLength={100}
                  />
                  <TextField
                    label="Contact name"
                    value={row.contactName}
                    onChange={(contactName) => updateContact(row.key, { contactName })}
                    error={errors[`contacts.${i}.contactName`]}
                    hint="If not the subscriber"
                    maxLength={100}
                  />
                  <label className="mt-7 flex items-center gap-1 text-sm text-ink">
                    <input
                      type="radio"
                      name="primaryContact"
                      checked={primaryKey === row.key}
                      onChange={() => setPrimaryKey(row.key)}
                    />
                    Primary
                  </label>
                  <button
                    type="button"
                    className="mt-6 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    onClick={() => removeContact(row.key)}
                    aria-label={`Remove contact ${i + 1}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {(areaOptions || collectorOptions) && (
          <section className="rounded-lg border border-slate-200 bg-surface p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Collection assignment</h2>
            <div className="grid grid-cols-2 gap-4">
              {areaOptions && (
                <SelectField label="Area" value={areaId} onChange={setAreaId} options={areaOptions} error={errors.collectionAreaId} />
              )}
              {collectorOptions && (
                <SelectField
                  label="Collector"
                  value={collectorId}
                  onChange={setCollectorId}
                  options={collectorOptions}
                  error={errors.assignedCollectorId}
                />
              )}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-slate-200 bg-surface p-5">
          <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={1000} />
        </section>
      </fieldset>

      {formError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
      >
        {saving ? "Creating…" : "Create subscriber"}
      </button>
    </form>
  );
}
