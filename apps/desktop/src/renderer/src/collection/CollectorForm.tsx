import { useState, type FormEvent } from "react";
import type { CollectorDto } from "../../../preload/index";
import { TextField } from "../ui/TextField";

export type CollectorFormMode = { kind: "create" } | { kind: "edit"; collector: CollectorDto };

interface CollectorFormProps {
  mode: CollectorFormMode;
  onSaved: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function CollectorForm({ mode, onSaved, onCancel, onExpired }: CollectorFormProps) {
  const editing = mode.kind === "edit" ? mode.collector : null;

  const [code, setCode] = useState("");
  const [fullName, setFullName] = useState(editing?.fullName ?? "");
  const [contactNumber, setContactNumber] = useState(editing?.contactNumber ?? "");
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    const errs: Record<string, string> = {};
    if (!editing && !code.trim()) errs.code = "Code is required.";
    if (!fullName.trim()) errs.fullName = "Full name is required.";
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setFormError(null);
      return;
    }

    const contactValue = contactNumber.trim() === "" ? null : contactNumber.trim();

    setSaving(true);
    setErrors({});
    setFormError(null);

    let result;
    if (editing) {
      // Send only what changed, so the audit trail shows a clean before and after.
      const changes: Record<string, unknown> = {};
      if (fullName.trim() !== editing.fullName) changes.fullName = fullName.trim();
      if (contactValue !== editing.contactNumber) changes.contactNumber = contactValue;
      if (isActive !== editing.isActive) changes.isActive = isActive;

      if (Object.keys(changes).length === 0) {
        setFormError("No changes to save.");
        setSaving(false);
        return;
      }
      if (reason.trim() !== "") changes.reason = reason.trim();
      result = await window.bcis.collectors.update(editing.id, changes);
    } else {
      result = await window.bcis.collectors.create({
        code: code.trim(),
        fullName: fullName.trim(),
        contactNumber: contactValue,
      });
    }

    if (result.ok) {
      onSaved();
      return;
    }
    if (result.code === "UNAUTHENTICATED") {
      onExpired();
      return;
    }

    const serverErrors: Record<string, string> = {};
    for (const issue of result.issues ?? []) {
      if (issue.path && !serverErrors[issue.path]) serverErrors[issue.path] = issue.message;
    }
    setErrors(serverErrors);
    setFormError(Object.keys(serverErrors).length > 0 ? null : result.message);
    setSaving(false);
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-6 rounded-lg border border-slate-200 bg-surface p-5"
    >
      <h2 className="text-base font-semibold text-navy">
        {editing ? `Edit collector ${editing.code}` : "New collector"}
      </h2>

      <fieldset className="mt-4" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
          Collector details
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField
            label="Code"
            value={editing ? editing.code : code}
            onChange={setCode}
            required
            disabled={!!editing}
            error={errors.code}
            hint={editing ? "The code cannot be changed." : "Letters, digits and hyphens."}
            maxLength={20}
          />
          <TextField
            label="Full name"
            value={fullName}
            onChange={setFullName}
            required
            error={errors.fullName}
            maxLength={100}
          />
          <TextField
            label="Contact number"
            value={contactNumber}
            onChange={setContactNumber}
            error={errors.contactNumber}
            maxLength={30}
          />
        </div>
        {editing && (
          <>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <TextField
                label="Reason for change"
                value={reason}
                onChange={setReason}
                hint="Recorded in the audit log."
                maxLength={200}
              />
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              Active (inactive collectors cannot be assigned new subscribers)
            </label>
          </>
        )}
      </fieldset>

      {formError && (
        <p
          role="alert"
          className="mt-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {formError}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Create collector"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-slate-50 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}