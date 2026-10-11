import { useEffect, useState } from "react";
import { ROLE_LABELS, type RoleCode } from "@bcis/shared";
import type { UserDto } from "../../../preload/index";
import { formatDateTime, RowError } from "../subscribers/ProfileParts";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { NameForm, NewUserForm, ResetPasswordForm, RolesForm, StatusForm, UnlockForm } from "./UserForms";

type FormMode =
  | { kind: "create" }
  | { kind: "name" | "roles" | "status" | "unlock" | "reset"; user: UserDto };

interface Notice {
  text: string;
  /** Shown in large type so the owner can copy it before closing the notice. */
  temporaryPassword?: string;
}

interface UsersScreenProps {
  /** The signed-in owner: actions the server refuses on your own account are not offered. */
  currentUserId: string;
  onSessionExpired: () => void;
}

const roleLabel = (code: string) => ROLE_LABELS[code as RoleCode] ?? code;

const actionClass = "btn btn-secondary btn-xs";

export function UsersScreen({ currentUserId, onSessionExpired }: UsersScreenProps) {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<FormMode | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.users.list().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUsers(result.data);
        setLoadError(null);
      } else if (result.code === "UNAUTHENTICATED") {
        onSessionExpired();
        return;
      } else {
        setLoadError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onSessionExpired]);

  function open(mode: FormMode) {
    setNotice(null);
    setForm(mode);
  }

  function saved(mode: FormMode, user: UserDto, temporaryPassword?: string) {
    setForm(null);
    setReloadKey((k) => k + 1);
    const who = `${user.fullName} (${user.username})`;
    const text =
      mode.kind === "create"
        ? `Created ${who}.`
        : mode.kind === "reset"
          ? `Password reset for ${who}. They have been signed out everywhere.`
          : mode.kind === "status"
            ? `${who} is now ${user.isActive ? "active" : "inactive"}.`
            : mode.kind === "unlock"
              ? `${who} can sign in again.`
              : `Saved changes to ${who}.`;
    setNotice(temporaryPassword ? { text, temporaryPassword } : { text });
  }

  const shown = showInactive ? users : users.filter((u) => u.isActive);
  const inactiveCount = users.length - users.filter((u) => u.isActive).length;

  const columns: Column<UserDto>[] = [
    {
      key: "username",
      header: "Username",
      render: (u) => (
        <span className="font-medium">
          {u.username}
          {u.id === currentUserId && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
        </span>
      ),
    },
    { key: "name", header: "Full name", render: (u) => u.fullName },
    { key: "roles", header: "Roles", render: (u) => (u.roles.length > 0 ? u.roles.map(roleLabel).join(", ") : "—") },
    {
      key: "status",
      header: "Status",
      render: (u) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={u.isActive ? "success" : "neutral"}>{u.isActive ? "Active" : "Inactive"}</Badge>
          {u.isLocked && <Badge tone="danger">Locked</Badge>}
          {u.mustChangePassword && <Badge tone="warning">Temporary password</Badge>}
        </span>
      ),
    },
    {
      key: "lastLogin",
      header: "Last sign-in",
      render: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="text-muted">Never</span>),
    },
    {
      key: "actions",
      header: "",
      render: (u) => {
        const self = u.id === currentUserId;
        return (
          <span className="flex flex-wrap justify-end gap-1">
            <button className={actionClass} onClick={() => open({ kind: "name", user: u })}>
              Edit name
            </button>
            <button className={actionClass} onClick={() => open({ kind: "roles", user: u })}>
              Roles
            </button>
            {u.isLocked && (
              <button className={actionClass} onClick={() => open({ kind: "unlock", user: u })}>
                Unlock
              </button>
            )}
            {!self && u.isActive && (
              <button className={actionClass} onClick={() => open({ kind: "reset", user: u })}>
                Reset password
              </button>
            )}
            {!self && (
              <button
                className={`${actionClass} ${u.isActive ? "text-danger" : ""}`}
                onClick={() => open({ kind: "status", user: u })}
              >
                {u.isActive ? "Deactivate" : "Reactivate"}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  const formProps = (mode: FormMode) => ({
    onSaved: (user: UserDto, temporaryPassword?: string) => saved(mode, user, temporaryPassword),
    onCancel: () => setForm(null),
    onExpired: onSessionExpired,
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Users</h1>
          <p className="text-sm text-muted">
            Accounts are deactivated, never deleted, so the audit trail keeps every name. Every change here is audited.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive{inactiveCount > 0 ? ` (${inactiveCount})` : ""}
          </label>
          <button
            className="btn btn-accent"
            onClick={() => open({ kind: "create" })}
          >
            New user
          </button>
        </div>
      </div>

      {notice && (
        <div role="status" className="mb-4 rounded-lg border border-success/30 tint-success px-4 py-3 text-sm text-ink">
          <div className="flex items-start justify-between gap-4">
            <p>{notice.text}</p>
            <button className="text-xs text-muted hover:underline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
          {notice.temporaryPassword && (
            <p className="mt-2">
              Temporary password:{" "}
              <code className="rounded bg-white px-2 py-1 font-mono text-base tracking-wider text-navy select-all">
                {notice.temporaryPassword}
              </code>
              <span className="ml-2 text-xs text-muted">
                Write it down for the user now. It is not stored anywhere readable and will not be shown again.
              </span>
            </p>
          )}
        </div>
      )}

      {form?.kind === "create" && <NewUserForm {...formProps(form)} />}
      {form?.kind === "name" && <NameForm key={form.user.id} user={form.user} {...formProps(form)} />}
      {form?.kind === "roles" && <RolesForm key={form.user.id} user={form.user} {...formProps(form)} />}
      {form?.kind === "status" && <StatusForm key={form.user.id} user={form.user} {...formProps(form)} />}
      {form?.kind === "unlock" && <UnlockForm key={form.user.id} user={form.user} {...formProps(form)} />}
      {form?.kind === "reset" && <ResetPasswordForm key={form.user.id} user={form.user} {...formProps(form)} />}

      {loadError && <RowError message={`Could not load users. ${loadError}`} />}

      {loading && users.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <DataTable
          columns={columns}
          rows={shown}
          getRowKey={(u) => u.id}
          emptyMessage={showInactive ? "No users yet." : "No active users. Try “Show inactive”."}
        />
      )}
    </div>
  );
}
