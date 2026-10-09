import { useState } from "react";
import { allowedStatusTransitions, type SubscriberStatus } from "@bcis/shared";
import type { SubscriberDto } from "../../../preload/index";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm } from "./ProfileForm";
import { statusLabel } from "./status";

const WARNINGS: Partial<Record<SubscriberStatus, string>> = {
  terminated: "Terminated accounts can only be archived afterwards. They cannot be made active again.",
  archived: "Archiving is final. The record becomes read-only and cannot be changed again.",
};

interface StatusFormProps {
  subscriber: SubscriberDto;
  onSaved: (updated: SubscriberDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function StatusForm({ subscriber, onSaved, onCancel, onExpired }: StatusFormProps) {
  // The same transition rules as the server, so only valid choices are offered.
  const choices = allowedStatusTransitions(subscriber.status as SubscriberStatus);
  const [status, setStatus] = useState<string>(choices[0] ?? "");
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (reason.trim().length < 3) {
      setErrors({ reason: "A reason is required." });
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    const result = await window.bcis.subscribers.changeStatus(subscriber.id, { status, reason: reason.trim() });
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  const warning = WARNINGS[status as SubscriberStatus];

  return (
    <ProfileForm
      title={`Change status (currently ${statusLabel(subscriber.status)})`}
      submitLabel={`Change to ${statusLabel(status)}`}
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <SelectField
          label="New status"
          value={status}
          onChange={setStatus}
          options={choices.map((s) => ({ value: s, label: statusLabel(s) }))}
          required
          error={errors.status}
        />
        <div className="col-span-2">
          <TextField label="Reason" value={reason} onChange={setReason} required error={errors.reason} hint="Required. Recorded in the history." maxLength={200} />
        </div>
      </div>
      {warning && (
        <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{warning}</p>
      )}
    </ProfileForm>
  );
}
