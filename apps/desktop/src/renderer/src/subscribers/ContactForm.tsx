import { useState } from "react";
import { CONTACT_TYPES, contactValueProblem, type ContactType } from "@bcis/shared";
import type { SubscriberContactDto, SubscriberDto } from "../../../preload/index";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm } from "./ProfileForm";
import { contactTypeLabel } from "./status";

interface ContactFormProps {
  subscriber: SubscriberDto;
  /** null adds a new contact. */
  contact: SubscriberContactDto | null;
  onSaved: (updated: SubscriberDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ContactForm({ subscriber, contact, onSaved, onCancel, onExpired }: ContactFormProps) {
  // The type is fixed once the contact exists.
  const [type, setType] = useState<string>(contact?.type ?? "mobile");
  const [value, setValue] = useState(contact?.value ?? "");
  const [contactName, setContactName] = useState(contact?.contactName ?? "");
  const [isPrimary, setIsPrimary] = useState(false);
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    // Same check the server runs, so most mistakes show before sending.
    const problem = contactValueProblem(type as ContactType, value);
    setErrors(problem ? { value: problem } : {});
    if (problem) return;

    const nameValue = contactName.trim() === "" ? null : contactName.trim();

    let request;
    if (contact) {
      const changes: Record<string, unknown> = {};
      if (value.trim() !== contact.value) changes.value = value.trim();
      if (nameValue !== contact.contactName) changes.contactName = nameValue;
      if (Object.keys(changes).length === 0) {
        setFormError("No changes to save.");
        return;
      }
      if (reason.trim() !== "") changes.reason = reason.trim();
      request = window.bcis.subscribers.updateContact(subscriber.id, contact.id, changes);
    } else {
      request = window.bcis.subscribers.addContact(subscriber.id, {
        type,
        value: value.trim(),
        contactName: nameValue,
        isPrimary,
      });
    }

    setSaving(true);
    setFormError(null);
    const result = await request;
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    // The server reports a bad value for the stored type as a code, not a field issue.
    if (result.code === "INVALID_CONTACT_VALUE") {
      setErrors({ value: result.message });
      setFormError(null);
    } else {
      setErrors(mapped.fields);
      setFormError(mapped.form);
    }
    setSaving(false);
  }

  return (
    <ProfileForm
      title={contact ? "Edit contact" : "Add contact"}
      submitLabel={contact ? "Save changes" : "Add contact"}
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={CONTACT_TYPES.map((t) => ({ value: t, label: contactTypeLabel(t) }))}
          disabled={contact !== null}
          error={errors.type}
        />
        <TextField label="Value" value={value} onChange={setValue} required error={errors.value} maxLength={100} />
        <TextField
          label="Contact name"
          value={contactName}
          onChange={setContactName}
          error={errors.contactName}
          hint="If not the subscriber"
          maxLength={100}
        />
      </div>
      {contact ? (
        <TextField label="Reason for change" value={reason} onChange={setReason} error={errors.reason} hint="Optional. Recorded in the history." maxLength={200} />
      ) : (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Make this the primary contact (replaces the current primary)
        </label>
      )}
    </ProfileForm>
  );
}
