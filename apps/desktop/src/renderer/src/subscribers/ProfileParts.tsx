import type { ReactNode } from "react";

// Layout pieces shared by the subscriber profile and the service account screen.

const DATE_TIME = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" });
export const formatDateTime = (iso: string) => DATE_TIME.format(new Date(iso));

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" onClick={onClick}>
      {label}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

export function RowError({ message }: { message: string }) {
  return (
    <p role="alert" className="mb-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
