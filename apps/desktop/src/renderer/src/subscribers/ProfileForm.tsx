import type { FormEvent, ReactNode } from "react";
import type { ApiFailure } from "../../../preload/index";

/** Field errors keyed by path, plus a form-level message when no field matched. */
export function failureToErrors(failure: ApiFailure): { fields: Record<string, string>; form: string | null } {
  const fields: Record<string, string> = {};
  for (const issue of failure.issues ?? []) {
    if (issue.path && !fields[issue.path]) fields[issue.path] = issue.message;
  }
  return { fields, form: Object.keys(fields).length > 0 ? null : failure.message };
}

/** Field errors from a failed shared-schema check, so the form shows the same messages the server would. */
export function schemaErrors(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".") || "form";
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

interface ProfileFormProps {
  title: string;
  submitLabel: string;
  saving: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}

/** The frame every inline form on the profile shares: title, fields, error, buttons. */
export function ProfileForm({ title, submitLabel, saving, error, onSubmit, onCancel, children }: ProfileFormProps) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!saving) onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 rounded-lg border border-accent/30 bg-slate-50 p-4">
      <h3 className="text-sm font-semibold text-navy">{title}</h3>
      <fieldset className="mt-3 space-y-3" disabled={saving}>
        {children}
      </fieldset>

      {error && (
        <p role="alert" className="alert alert-danger mt-3">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="btn btn-primary"
        >
          {saving ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="btn btn-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  maxLength?: number;
}

export function TextAreaField({ label, value, onChange, error, maxLength }: TextAreaFieldProps) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      <textarea
        className={error ? "field field-error" : "field"}
        rows={3}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span role="alert" className="mt-1 block text-xs font-normal text-danger">
          {error}
        </span>
      )}
    </label>
  );
}
