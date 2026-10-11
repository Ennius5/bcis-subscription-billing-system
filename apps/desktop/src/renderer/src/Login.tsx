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
  const [serverAddress, setServerAddress] = useState<{ apiUrl: string; fixedByEnvironment: boolean } | null>(null);
  const [editingServer, setEditingServer] = useState(false);
  const [addressInput, setAddressInput] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [testingAddress, setTestingAddress] = useState(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    setServer("checking");
    void window.bcis.server.get().then(setServerAddress);
    void window.bcis.getHealth().then((r) => setServer(r.ok ? "connected" : "unreachable"));
  }, [recheck]);

  async function saveServerAddress(event: FormEvent) {
    event.preventDefault();
    if (testingAddress) return;
    setTestingAddress(true);
    setAddressError(null);
    const result = await window.bcis.server.set(addressInput);
    setTestingAddress(false);
    if (!result.ok) {
      setAddressError(result.message);
      return;
    }
    setEditingServer(false);
    setRecheck((n) => n + 1);
  }

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

        <div className="mt-4 text-center text-xs text-muted">
          <p>
            Server {serverAddress?.apiUrl ?? ""}:{" "}
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
            {serverAddress && !serverAddress.fixedByEnvironment && !editingServer && (
              <button
                type="button"
                className="ml-2 text-accent hover:underline"
                onClick={() => {
                  setAddressInput(serverAddress.apiUrl);
                  setAddressError(null);
                  setEditingServer(true);
                }}
              >
                Change
              </button>
            )}
          </p>
          {server === "unreachable" && !editingServer && (
            <p className="mt-1">Check the network cable or Wi-Fi, or ask the administrator for the server address.</p>
          )}
          {editingServer && (
            <form
              onSubmit={(e) => void saveServerAddress(e)}
              className="mt-3 rounded-lg border border-slate-200 bg-surface p-3 text-left"
            >
              <label className="block text-sm font-medium text-ink">
                Server address
                <input
                  className={inputClass}
                  value={addressInput}
                  maxLength={200}
                  autoFocus
                  disabled={testingAddress}
                  placeholder="192.168.1.10 or http://server:3000"
                  onChange={(e) => setAddressInput(e.target.value)}
                />
              </label>
              <p className="mt-1 text-xs text-muted">The address of the PC running the BCIS server. Port 3000 is used when none is given.</p>
              {addressError && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {addressError}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={testingAddress}
                  className="rounded bg-navy px-3 py-1.5 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
                >
                  {testingAddress ? "Testing…" : "Test and save"}
                </button>
                <button
                  type="button"
                  disabled={testingAddress}
                  onClick={() => setEditingServer(false)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-ink hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}