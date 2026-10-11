import { useState } from "react";
import { PASSWORD_MIN_LENGTH, passwordChangeSchema } from "@bcis/shared";
import type { SessionInfo } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { TextField } from "../ui/TextField";

interface PasswordFieldsProps {
  title: string;
  submitLabel: string;
  onChanged: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

/** Current password, new password twice. The server checks the current one again. */
function PasswordFields({ title, submitLabel, onChanged, onCancel, onExpired }: PasswordFieldsProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { errors, formError, saving, reject, save } = useSave(() => onChanged(), onExpired);

  function submit() {
    const parsed = passwordChangeSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    if (confirm !== newPassword) return reject({ confirm: "The two new passwords do not match." });
    void save(() => window.bcis.changePassword(parsed.data));
  }

  return (
    <ProfileForm
      title={title}
      submitLabel={submitLabel}
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <TextField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrentPassword}
        required
        error={errors.currentPassword}
        maxLength={256}
      />
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={setNewPassword}
        required
        error={errors.newPassword}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence is easier to remember than symbols.`}
        maxLength={256}
      />
      <TextField
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
        required
        error={errors.confirm}
        maxLength={256}
      />
    </ProfileForm>
  );
}

interface ForcedPasswordChangeProps {
  session: SessionInfo;
  onChanged: () => void;
  onSignOut: () => void;
}

/**
 * Shown instead of the app after signing in with a temporary password. The server refuses
 * every other request until this succeeds, so the screen is a convenience, not the guard.
 */
export function ForcedPasswordChange({ session, onChanged, onSignOut }: ForcedPasswordChangeProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="aero-sheet w-full max-w-md p-6">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-navy">Choose a new password</h1>
          <p className="mt-1 text-sm text-muted">
            Hello {session.user.fullName}. You signed in with a temporary password from the owner. Choose your own
            password to continue. Nobody else will know it.
          </p>
        </div>
        <PasswordFields
          title={`Signed in as ${session.user.username}`}
          submitLabel="Save and continue"
          onChanged={onChanged}
          onCancel={onSignOut}
          onExpired={onSignOut}
        />
        <p className="text-center text-xs text-muted">Cancel signs you out.</p>
      </div>
    </div>
  );
}

interface ChangePasswordPanelProps {
  onClose: () => void;
  onExpired: () => void;
}

/** Change my password, opened from the header. Stays signed in on this PC; other PCs are signed out. */
export function ChangePasswordPanel({ onClose, onExpired }: ChangePasswordPanelProps) {
  const [done, setDone] = useState(false);

  return (
    <div className="max-w-md">
      <h1 className="mb-4 text-xl font-semibold text-navy">Change my password</h1>
      {done ? (
        <div className="rounded-lg border border-success/30 tint-success p-4 text-sm text-ink">
          <p>
            <strong className="text-success">Password changed.</strong> You stay signed in here. If you were signed in
            on another PC, that session has been ended.
          </p>
          <button
            onClick={onClose}
            className="btn btn-primary mt-3"
          >
            Back to work
          </button>
        </div>
      ) : (
        <PasswordFields
          title="Enter your current password, then the new one twice"
          submitLabel="Change password"
          onChanged={() => setDone(true)}
          onCancel={onClose}
          onExpired={onExpired}
        />
      )}
    </div>
  );
}
