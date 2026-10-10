import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * Catches a crash while drawing a screen, so the user sees a message and the menu
 * instead of a blank window. Data is never at risk here: the renderer only displays
 * what the API returned. Give it a `key` per screen so switching screens resets it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    void window.bcis.logRendererError(error.message, info.componentStack ?? error.stack ?? null);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="max-w-xl rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-ink">
        <p>
          <strong className="text-danger">This screen could not be shown.</strong> The problem has been recorded on
          this PC. Your saved data is not affected.
        </p>
        <p className="mt-2 text-muted">Pick another item in the menu, or try this screen again.</p>
        <button
          onClick={() => this.setState({ failed: false })}
          className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-white"
        >
          Try again
        </button>
      </div>
    );
  }
}
