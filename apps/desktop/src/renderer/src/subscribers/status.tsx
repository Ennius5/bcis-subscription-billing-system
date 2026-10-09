import { Badge, type BadgeTone } from "../ui/Badge";

// Covers both subscriber statuses and service account statuses.
const STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  inactive: "warning",
  suspended: "warning",
  terminated: "danger",
  archived: "neutral",
  pending: "neutral",
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  internet: "Internet",
  cable: "Cable",
  combo: "Combo",
};

export function serviceTypeLabel(type: string): string {
  return SERVICE_TYPE_LABELS[type] ?? type;
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const CONTACT_TYPE_LABELS: Record<string, string> = {
  mobile: "Mobile",
  landline: "Landline",
  email: "Email",
  other: "Other",
};

export function contactTypeLabel(type: string): string {
  return CONTACT_TYPE_LABELS[type] ?? type;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{statusLabel(status)}</Badge>;
}
