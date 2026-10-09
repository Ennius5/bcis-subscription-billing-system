import { COLLECTION_BATCH_STATUS_LABELS, COLLECTION_BATCH_STATUSES, type CollectionBatchStatus } from "@bcis/shared";
import { Badge, type BadgeTone } from "../ui/Badge";
import type { SelectOption } from "../ui/SelectField";

// Waiting on someone (collector out, cash not yet counted) is amber; finished is green.
const TONES: Record<CollectionBatchStatus, BadgeTone> = {
  open: "neutral",
  in_progress: "warning",
  submitted: "warning",
  remitted: "warning",
  reconciled: "success",
  closed: "success",
  cancelled: "danger",
};

export function batchStatusLabel(status: string): string {
  return COLLECTION_BATCH_STATUS_LABELS[status as CollectionBatchStatus] ?? status;
}

/** Text plus colour, never colour alone. */
export function BatchStatusBadge({ status }: { status: string }) {
  return <Badge tone={TONES[status as CollectionBatchStatus] ?? "neutral"}>{batchStatusLabel(status)}</Badge>;
}

export const BATCH_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: "", label: "All statuses" },
  ...COLLECTION_BATCH_STATUSES.map((s) => ({ value: s, label: COLLECTION_BATCH_STATUS_LABELS[s] })),
];

/** "Purok 1, Poblacion, Malaybalay" from a route sheet line. */
export function addressText(a: { addressLine: string | null; barangay: string | null; city: string | null }): string {
  return [a.addressLine, a.barangay, a.city].filter(Boolean).join(", ");
}
