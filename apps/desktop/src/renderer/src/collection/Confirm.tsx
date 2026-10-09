import type { ReactNode } from "react";

interface ConfirmProps {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

/** An inline "are you sure" box for a batch step that cannot be undone. */
export function Confirm({ title, confirmLabel, busy, onConfirm, onCancel, children }: ConfirmProps) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
      <h3 className="text-sm font-semibold text-navy">{title}</h3>
      <div className="mt-1 text-sm text-ink">{children}</div>
      <div className="mt-3 flex gap-3">
        <button
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-white disabled:opacity-60"
          disabled={busy}
          onClick={onCancel}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
