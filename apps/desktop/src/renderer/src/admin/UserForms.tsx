import { useState } from "react";
import {
  PASSWORD_MIN_LENGTH,
  passwordResetSchema,
  ROLE_DEFINITIONS,
  userCreateSchema,
  userRolesChangeSchema,
  userStatusChangeSchema,
  userUnlockSchema,
  userUpdateSchema,
} from "@bcis/shared";
import type { UserDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { TextField } from "../ui/TextField";

// No 0/O, 1/l/i: the owner reads this aloud or writes it on paper for the new user.
const READABLE = "abcdefghjkmnpqrstuvwxyz23456789";

/** A random temporary password like "k7pm-x3rq-9tdw". Only used once: the user must replace it. */
export function generateTemporaryPassword(): string {
  const chars: string[] = [];
  while (chars.length < 12) {
    const [byte = 255] = crypto.getRandomValues(new Uint8Array(1));
    // Rejection sampling keeps every character equally likely (248 = 8 * 31).
    if (byte < 248) chars.push(READABLE[byte % READABLE.length] ?? "");
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join("")).join("-");
}

interface FormProps {
  /** temporaryPassword is passed back by the forms that set one, so the screen can show it once more. */
  onSaved: (user: UserDto, temporaryPassword?: string) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function TemporaryPasswordField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        {/* Shown in plain text on purpose: the owner has to pass it on, and it only works once. */}
        <TextField
          label="Temporary password"
          value={value}
          onChange={onChange}
          required
          error={error}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Give it to the user in person; they must change it at first sign-in.`}
          maxLength={256}
          autoComplete="off"
        />
      </div>
      <button
        type="button"
        onClick={() => onChange(generateTemporaryPassword())}
        className="mb-6 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-white"
      >
        Generate
      </button>
    </div>
  );
}

function RoleChecklist({
  selected,
  onChange,
  error,
}: {
  selected: string[];
  onChange: (roles: string[]) => void;
  error?: string | undefined;
}) {
  function toggle(code: string, on: boolean) {
    onChange(on ? [...selected, code] : selected.filter((c) => c !== code));
  }
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">
        Roles <span className="text-danger" aria-hidden="true">*</span>
      </legend>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
        {ROLE_DEFINITIONS.map((role) => (
          <label key={role.code} className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(role.code)}
              onChange={(e) => toggle(role.code, e.target.checked)}
            />
            <span>
              {role.name}
              <span className="block text-xs text-muted">{role.description}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      )}
    </fieldset>
  );
}

export function NewUserForm({ onSaved, onCancel, onExpired }: FormProps) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState(generateTemporaryPassword);
  const [roles, setRoles] = useState<string[]>([]);
  const { errors, formError, saving, reject, save } = useSave((user: UserDto) => onSaved(user, temporaryPassword), onExpired);

  function submit() {
    const parsed = userCreateSchema.safeParse({ username, fullName, temporaryPassword, roles });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.create(parsed.data));
  }

  return (
    <ProfileForm title="New user" submitLabel="Create user" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Username"
          value={username}
          onChange={setUsername}
          required
          error={errors.username}
          hint="Used to sign in. Cannot be changed later."
          maxLength={32}
          autoComplete="off"
        />
        <TextField label="Full name" value={fullName} onChange={setFullName} required error={errors.fullName} maxLength={150} />
      </div>
      <TemporaryPasswordField value={temporaryPassword} onChange={setTemporaryPassword} error={errors.temporaryPassword} />
      <RoleChecklist selected={roles} onChange={setRoles} error={errors.roles} />
    </ProfileForm>
  );
}

interface UserFormProps extends FormProps {
  user: UserDto;
}

export function NameForm({ user, onSaved, onCancel, onExpired }: UserFormProps) {
  const [fullName, setFullName] = useState(user.fullName);
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    if (fullName.trim() === user.fullName) return reject({}, "No changes to save.");
    const parsed = userUpdateSchema.safeParse({ fullName, ...(reason.trim() ? { reason } : {}) });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.update(user.id, parsed.data));
  }

  return (
    <ProfileForm title={`Edit name of ${user.username}`} submitLabel="Save name" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Full name" value={fullName} onChange={setFullName} required error={errors.fullName} maxLength={150} />
        <TextField label="Reason" value={reason} onChange={setReason} error={errors.reason} hint="Optional." maxLength={200} />
      </div>
    </ProfileForm>
  );
}

export function RolesForm({ user, onSaved, onCancel, onExpired }: UserFormProps) {
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const unchanged = roles.length === user.roles.length && roles.every((r) => user.roles.includes(r));
    if (unchanged) return reject({}, "No changes to save.");
    const parsed = userRolesChangeSchema.safeParse({ roles, ...(reason.trim() ? { reason } : {}) });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.changeRoles(user.id, parsed.data));
  }

  return (
    <ProfileForm title={`Roles of ${user.username}`} submitLabel="Save roles" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <RoleChecklist selected={roles} onChange={setRoles} error={errors.roles} />
      <p className="text-xs text-muted">The change applies at the user&apos;s next click; they do not need to sign in again.</p>
      <TextField label="Reason" value={reason} onChange={setReason} error={errors.reason} hint="Optional." maxLength={200} />
    </ProfileForm>
  );
}

export function StatusForm({ user, onSaved, onCancel, onExpired }: UserFormProps) {
  const deactivating = user.isActive;
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = userStatusChangeSchema.safeParse({ isActive: !deactivating, reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.changeStatus(user.id, parsed.data));
  }

  return (
    <ProfileForm
      title={`${deactivating ? "Deactivate" : "Reactivate"} ${user.username}`}
      submitLabel={deactivating ? "Deactivate user" : "Reactivate user"}
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {deactivating && (
        <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          The user is signed out on every PC at once and cannot sign in again until reactivated. Their past work and
          audit history stay.
        </p>
      )}
      <TextField label="Reason" value={reason} onChange={setReason} required error={errors.reason} hint="Required. Recorded in the audit log." maxLength={200} />
    </ProfileForm>
  );
}

export function UnlockForm({ user, onSaved, onCancel, onExpired }: UserFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = userUnlockSchema.safeParse(reason.trim() ? { reason } : {});
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.unlock(user.id, parsed.data));
  }

  return (
    <ProfileForm title={`Unlock ${user.username}`} submitLabel="Unlock now" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <p className="text-sm text-ink">
        The account was locked after 5 wrong passwords. Unlocking lets the user try again now instead of waiting 15
        minutes. If they forgot the password, use Reset password instead.
      </p>
      <TextField label="Reason" value={reason} onChange={setReason} error={errors.reason} hint="Optional." maxLength={200} />
    </ProfileForm>
  );
}

export function ResetPasswordForm({ user, onSaved, onCancel, onExpired }: UserFormProps) {
  const [temporaryPassword, setTemporaryPassword] = useState(generateTemporaryPassword);
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave((saved: UserDto) => onSaved(saved, temporaryPassword), onExpired);

  function submit() {
    const parsed = passwordResetSchema.safeParse({ temporaryPassword, ...(reason.trim() ? { reason } : {}) });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.users.resetPassword(user.id, parsed.data));
  }

  return (
    <ProfileForm title={`Reset password of ${user.username}`} submitLabel="Reset password" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <p className="text-sm text-ink">
        The user is signed out everywhere and any lockout is lifted. At their next sign-in they must replace this
        temporary password with their own.
      </p>
      <TemporaryPasswordField value={temporaryPassword} onChange={setTemporaryPassword} error={errors.temporaryPassword} />
      <TextField label="Reason" value={reason} onChange={setReason} error={errors.reason} hint="Optional." maxLength={200} />
    </ProfileForm>
  );
}
