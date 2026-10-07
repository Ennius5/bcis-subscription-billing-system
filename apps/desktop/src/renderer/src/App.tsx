import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../preload/index";
import { Login } from "./Login";
import { Shell } from "./Shell";

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

  // Stable identity so screens can safely list it as an effect dependency.
  const handleSignOut = useCallback(async () => {
    await window.bcis.logout();
    setState({ kind: "signedOut" });
  }, []);

  if (state.kind === "loading") return null;

  if (state.kind === "signedOut") {
    return <Login onSignedIn={(session) => setState({ kind: "signedIn", session })} />;
  }

  return <Shell session={state.session} onSignOut={handleSignOut} />;
}