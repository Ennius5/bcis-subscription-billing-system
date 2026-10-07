import type { ReactNode } from "react";

export type BadgeTone = "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<BadgeTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-slate-100 text-muted",
};

/** Always pass a text label: status is never conveyed by color alone. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}