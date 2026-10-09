import { periodOf } from "@bcis/shared";
import { Badge, type BadgeTone } from "../ui/Badge";

const LABELS: Record<string, string> = {
  draft: "Draft",
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
  credited: "Credited",
};

const TONES: Record<string, BadgeTone> = {
  draft: "neutral",
  unpaid: "warning",
  partially_paid: "warning",
  paid: "success",
  overdue: "danger",
  void: "neutral",
  credited: "success",
};

export function invoiceStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}

/** Pass the display status, so overdue invoices show as Overdue. Always text plus colour. */
export function InvoiceStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONES[status] ?? "neutral"}>{invoiceStatusLabel(status)}</Badge>;
}

/** This PC's current month, "YYYY-MM": only a starting value for pickers; the server decides what is allowed. */
export function currentMonth(): string {
  const d = new Date();
  return periodOf(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
}
