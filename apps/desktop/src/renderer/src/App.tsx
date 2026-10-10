import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../preload/index";
import { ForcedPasswordChange } from "./account/ChangePassword";
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
  // Stable and void-returning: screens pass it on as onSessionExpired and list it in effect deps.
  // logout() never rejects (the main process signs out locally even if the server call fails).
  const handleSignOut = useCallback(() => {
    void window.bcis.logout().then(() => setState({ kind: "signedOut" }));
  }, []);

  if (state.kind === "loading") return null;

  if (state.kind === "signedOut") {
    return <Login onSignedIn={(session) => setState({ kind: "signedIn", session })} />;
  }

  if (state.session.user.mustChangePassword) {
    return (
      <ForcedPasswordChange
        session={state.session}
        // Same session, now cleared by the server: just mark the flag as done.
        onChanged={() =>
          setState({
            kind: "signedIn",
            session: { ...state.session, user: { ...state.session.user, mustChangePassword: false } },
          })
        }
        onSignOut={handleSignOut}
      />
    );
  }

  return <Shell session={state.session} onSignOut={handleSignOut} />;
}