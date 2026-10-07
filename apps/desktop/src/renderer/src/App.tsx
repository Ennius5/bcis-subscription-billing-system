import { useEffect, useState } from "react";
import type { SessionInfo } from "../../preload/index";
import { Login } from "./Login";

type AppState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; session: SessionInfo };

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });

  // Restore an existing session (e.g. after a reload) if the main process still has one.
  useEffect(() => {
    void window.bcis.me().then((result) => {
      setState(
        result.ok
          ? { kind: "signedIn", session: { user: result.user, permissions: result.permissions } }
          : { kind: "signedOut" },
      );
    });
  }, []);

  async function handleSignOut() {
    await window.bcis.logout();
    setState({ kind: "signedOut" });
  }

  if (state.kind === "loading") return null;

  if (state.kind === "signedOut") {
    return <Login onSignedIn={(session) => setState({ kind: "signedIn", session })} />;
  }

  // Placeholder shell. The permission-aware navigation comes in the next step.
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between bg-navy px-6 py-3 text-white">
        <span className="font-semibold">BCIS Billing</span>
        <span className="flex items-center gap-4 text-sm">
          {state.session.user.fullName}
          <button
            onClick={() => void handleSignOut()}
            className="rounded border border-white/40 px-3 py-1 hover:bg-white/10"
          >
            Sign out
          </button>
        </span>
      </header>
      <main className="p-8">
        <p className="text-muted">Signed in. Navigation comes next.</p>
      </main>
    </div>
  );
}