import { useEffect, useState, type FormEvent } from "react";
import type { SessionInfo } from "../../preload/index";

interface LoginProps {
  onSignedIn: (session: SessionInfo) => void;
}

type ServerStatus = "checking" | "connected" | "unreachable";

export function Login({ onSignedIn }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [server, setServer] = useState<ServerStatus>("checking");

  useEffect(() => {
    void window.bcis.getHealth().then((r) => setServer(r.ok ? "connected" : "unreachable"));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await window.bcis.login(username, password);
    if (result.ok) {
      onSignedIn({ user: result.user, permissions: result.permissions });
      return;
    }
    setError(result.message);
    setPassword("");
    setSubmitting(false);
  }

  const inputClass =
    "mt-1 block w-full rounded border border-slate-300 bg-surface px-3 py-2 text-ink " +
    "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-navy">BCIS Billing</h1>
          <p className="mt-1 text-sm text-muted">
            Subscription Billing and Collection System
          </p>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-lg border border-slate-200 bg-surface p-6 shadow-sm"
        >
          <label className="block text-sm font-medium text-ink">
            Username <span className="text-danger" aria-hidden="true">*</span>
            <input
              className={inputClass}
              type="text"
              autoComplete="username"
              autoFocus
              required
              maxLength={64}
              value={username}
              disabled={submitting}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>

          <label className="mt-4 block text-sm font-medium text-ink">
            Password <span className="text-danger" aria-hidden="true">*</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              disabled={submitting}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
            >
              <strong>Sign-in failed.</strong> {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">
          Server:{" "}
          <strong
            className={
              server === "connected"
                ? "text-success"
                : server === "unreachable"
                  ? "text-danger"
                  : "text-muted"
            }
          >
            {server}
          </strong>
        </p>
      </div>
    </div>
  );
}