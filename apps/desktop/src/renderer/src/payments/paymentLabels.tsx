import { COUNTER_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@bcis/shared";
import { Badge } from "../ui/Badge";
import type { SelectOption } from "../ui/SelectField";

export const METHOD_LABELS: Record<PaymentMethod, string> = PAYMENT_METHOD_LABELS;

export function methodLabel(method: string): string {
  return METHOD_LABELS[method as PaymentMethod] ?? method;
}

/** Receive Payment offers counter methods only; GCash goes through verification. */
export const COUNTER_METHOD_OPTIONS: readonly SelectOption[] = COUNTER_PAYMENT_METHODS.map((m) => ({
  value: m,
  label: METHOD_LABELS[m],
}));

/** Text plus colour: a reversed receipt stays visible but is clearly void. */
export function PaymentStatusBadge({ status }: { status: string }) {
  return status === "reversed" ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Posted</Badge>;
}

/** This PC's date, "YYYY-MM-DD": only a starting value for the form; the server refuses future dates. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
