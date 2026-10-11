import type { ReactNode } from "react";

// Layout pieces shared by the subscriber profile and the service account screen.

const DATE_TIME = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" });
export const formatDateTime = (iso: string) => DATE_TIME.format(new Date(iso));

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel p-4">
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
    <button className="btn btn-secondary btn-xs" onClick={onClick}>
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
    <p role="alert" className="alert alert-danger mb-3">
      {message}
    </p>
  );
}
