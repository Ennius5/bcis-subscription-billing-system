import { useEffect, useState, type FormEvent } from "react";
import type { AvailableUserDto, CollectorDto } from "../../../preload/index";
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
  const [userId, setUserId] = useState(editing?.userId ?? ""); // "" means no login
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [reason, setReason] = useState("");

  const [availableUsers, setAvailableUsers] = useState<AvailableUserDto[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.collectors.availableUsers().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAvailableUsers(result.data);
        setUsersError(null);
      } else if (result.code === "UNAUTHENTICATED") {
        onExpired();
        return;
      } else {
        setUsersError(result.message);
      }
      setUsersLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [onExpired]);

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
    const userIdValue = userId === "" ? null : userId;

    setSaving(true);
    setErrors({});
    setFormError(null);

    let result;
    if (editing) {
      // Send only what changed, so the audit trail shows a clean before and after.
      const changes: Record<string, unknown> = {};
      if (fullName.trim() !== editing.fullName) changes.fullName = fullName.trim();
      if (contactValue !== editing.contactNumber) changes.contactNumber = contactValue;
      if (userIdValue !== editing.userId) changes.userId = userIdValue;
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
        ...(userIdValue !== null ? { userId: userIdValue } : {}),
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

  // The endpoint excludes users who are already linked, so the current login is added back.
  const otherUsers = availableUsers.filter((u) => u.id !== editing?.userId);

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
      </fieldset>

      <fieldset className="mt-5" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
          Login account
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block text-sm font-medium text-ink">
            Linked user
            <select
              className="mt-1 block w-full rounded border border-slate-300 bg-surface px-3 py-2 font-normal disabled:bg-slate-100 disabled:opacity-70"
              value={userId}
              disabled={usersLoading}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">No login</option>
              {editing?.userId && (
                <option value={editing.userId}>{editing.username ?? "Current login"} (current)</option>
              )}
              {otherUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} — {u.fullName}
                </option>
              ))}
            </select>
            {errors.userId && (
              <span role="alert" className="mt-1 block text-xs font-normal text-danger">
                {errors.userId}
              </span>
            )}
            {usersError && (
              <span className="mt-1 block text-xs font-normal text-danger">
                Could not load users. {usersError}
              </span>
            )}
            {!errors.userId && !usersError && (
              <span className="mt-1 block text-xs font-normal text-muted">
                Optional. Only users not linked to another collector are listed.
              </span>
            )}
          </label>
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