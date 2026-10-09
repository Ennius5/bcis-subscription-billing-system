import { z } from "zod";
import type { Centavos } from "./money";

/*
 * Receivables and service control (spec 3.9, 3.10), as decided for this project:
 * - Aging is as of today, by due date, on each open invoice's balance (effective total less
 *   paid). "Overdue" means past due; the grace period only matters for suspension candidates.
 * - A suspension candidate is an active service account with at least the threshold number of
 *   open invoices more than the grace period past due. The list is advice: staff suspend by hand.
 * - Suspend and reconnect are their own actions. A reconnection can be requested once no
 *   past-due open invoice is left on the account (the current bill may still be open).
 * - The reconnection fee is the plan's, billed on the next generated invoice unless waived.
 * Dates are "YYYY-MM-DD" strings, which compare correctly as text.
 */

/* ------------------------------- Dates ------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtc(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Days from `dueDate` to `today`: 0 on the due date, negative before it. */
export function daysPastDue(dueDate: string, today: string): number {
  return Math.round((toUtc(today) - toUtc(dueDate)) / DAY_MS);
}

/* ------------------------------- Aging ------------------------------- */

export const AGING_BUCKETS = ["current", "days_1_30", "days_31_60", "days_61_90", "days_90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  days_1_30: "1–30 days",
  days_31_60: "31–60 days",
  days_61_90: "61–90 days",
  days_90_plus: "90+ days",
};

/** Not yet past due (including the due date itself) is current. */
export function agingBucket(dueDate: string, today: string): AgingBucket {
  const days = daysPastDue(dueDate, today);
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "days_90_plus";
}

export interface OpenInvoiceAge {
  dueDate: string;
  /** Effective total less paid; only open invoices are passed in. */
  openCentavos: Centavos;
}

export type AgingTotals = Record<AgingBucket, Centavos>;

export function emptyAgingTotals(): AgingTotals {
  return { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 };
}

/** Sums open balances into the aging buckets. */
export function agingTotals(invoices: readonly OpenInvoiceAge[], today: string): AgingTotals {
  const totals = emptyAgingTotals();
  for (const invoice of invoices) totals[agingBucket(invoice.dueDate, today)] += invoice.openCentavos;
  return totals;
}

/* ------------------------------ Settings ------------------------------ */

export const GRACE_PERIOD_DAYS_MAX = 60;
export const SUSPENSION_THRESHOLD_MAX = 12;

/** Keys in application_settings. */
export const RECEIVABLE_SETTING_KEYS = {
  gracePeriodDays: "grace_period_days",
  suspensionThresholdInvoices: "suspension_threshold_invoices",
} as const;

export const RECEIVABLE_SETTING_DEFAULTS = { gracePeriodDays: 7, suspensionThresholdInvoices: 1 } as const;

const gracePeriodDaysField = z
  .number()
  .int("Enter a whole number of days.")
  .min(0, "The grace period cannot be negative.")
  .max(GRACE_PERIOD_DAYS_MAX, `The grace period can be at most ${GRACE_PERIOD_DAYS_MAX} days.`);
const suspensionThresholdField = z
  .number()
  .int("Enter a whole number of invoices.")
  .min(1, "The threshold must be at least 1 invoice.")
  .max(SUSPENSION_THRESHOLD_MAX, `The threshold can be at most ${SUSPENSION_THRESHOLD_MAX} invoices.`);

export const receivableSettingsSchema = z.object({
  gracePeriodDays: gracePeriodDaysField,
  suspensionThresholdInvoices: suspensionThresholdField,
});
export type ReceivableSettings = z.infer<typeof receivableSettingsSchema>;

export const receivableSettingsUpdateSchema = z
  .strictObject({
    gracePeriodDays: gracePeriodDaysField.optional(),
    suspensionThresholdInvoices: suspensionThresholdField.optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "reason"), {
    message: "Provide at least one field to change.",
  });
export type ReceivableSettingsUpdateInput = z.infer<typeof receivableSettingsUpdateSchema>;

/* ------------------------------ Suspension ------------------------------ */

/** Past due by more than the grace period: due 1st, grace 7 -> counts from the 9th. */
export function isPastGrace(dueDate: string, today: string, gracePeriodDays: number): boolean {
  return daysPastDue(dueDate, today) > gracePeriodDays;
}

/** How many of a service account's open invoices are past the grace period. */
export function countPastGrace(
  invoices: readonly OpenInvoiceAge[],
  today: string,
  gracePeriodDays: number,
): number {
  return invoices.filter((i) => i.openCentavos > 0 && isPastGrace(i.dueDate, today, gracePeriodDays)).length;
}

/** Only active accounts can be candidates; terminated ones with debt stay in the lists only. */
export function isSuspensionCandidate(
  status: string,
  invoices: readonly OpenInvoiceAge[],
  today: string,
  settings: ReceivableSettings,
): boolean {
  return (
    status === "active" &&
    countPastGrace(invoices, today, settings.gracePeriodDays) >= settings.suspensionThresholdInvoices
  );
}

/** Returns why a reconnection cannot be requested yet, or null when payment qualifies. */
export function reconnectionPaymentProblem(invoices: readonly OpenInvoiceAge[], today: string): string | null {
  const pastDue = invoices.filter((i) => i.openCentavos > 0 && daysPastDue(i.dueDate, today) > 0);
  if (pastDue.length === 0) return null;
  return pastDue.length === 1
    ? "1 past-due invoice is still unpaid."
    : `${pastDue.length} past-due invoices are still unpaid.`;
}

/* ------------------------------ Reconnection ------------------------------ */

export const RECONNECTION_STATUSES = ["requested", "assigned", "completed", "cancelled"] as const;
export type ReconnectionStatus = (typeof RECONNECTION_STATUSES)[number];

export const RECONNECTION_STATUS_LABELS: Record<ReconnectionStatus, string> = {
  requested: "Requested",
  assigned: "Assigned",
  completed: "Completed",
  cancelled: "Cancelled",
};

// "assigned -> assigned" hands the job to another technician.
const RECONNECTION_TRANSITIONS: Record<ReconnectionStatus, readonly ReconnectionStatus[]> = {
  requested: ["assigned", "completed", "cancelled"],
  assigned: ["assigned", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Returns a user-facing message when the move is not allowed, or null when it is. */
export function reconnectionTransitionProblem(from: ReconnectionStatus, to: ReconnectionStatus): string | null {
  if (RECONNECTION_TRANSITIONS[from].includes(to)) return null;
  if (from === "completed" || from === "cancelled") return `This reconnection is already ${from}.`;
  return `A ${from} reconnection cannot be marked ${to}.`;
}

/* ------------------------------- Schemas ------------------------------- */

/** Omitted dates mean today on the server; services reject future dates. */
const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });
const requiredReason = z.string().trim().min(3, "A reason is required.").max(200);
const notes = z.string().trim().max(500).nullish();

export const serviceSuspendSchema = z.strictObject({
  reason: requiredReason,
  effectiveDate: isoDate.optional(),
  approvedBy: z.string().trim().min(2, "Enter who approved the suspension.").max(100),
  notes,
});
export type ServiceSuspendInput = z.infer<typeof serviceSuspendSchema>;

export const reconnectionRequestSchema = z
  .strictObject({
    requestDate: isoDate.optional(),
    waiveFee: z.boolean().default(false),
    feeWaiverReason: z.string().trim().max(200).optional(),
    notes,
  })
  .superRefine((v, ctx) => {
    const reason = v.feeWaiverReason ?? "";
    if (v.waiveFee && reason.length < 3) {
      ctx.addIssue({ code: "custom", message: "Say why the fee is waived.", path: ["feeWaiverReason"] });
    }
    if (!v.waiveFee && reason !== "") {
      ctx.addIssue({
        code: "custom",
        message: "A waiver reason only applies when the fee is waived.",
        path: ["feeWaiverReason"],
      });
    }
  });
export type ReconnectionRequestInput = z.infer<typeof reconnectionRequestSchema>;

export const reconnectionAssignSchema = z.strictObject({
  technicianUserId: z.uuid({ message: "Choose a technician." }),
});
export type ReconnectionAssignInput = z.infer<typeof reconnectionAssignSchema>;

export const reconnectionCompleteSchema = z.strictObject({
  completionDate: isoDate.optional(),
});
export type ReconnectionCompleteInput = z.infer<typeof reconnectionCompleteSchema>;

export const reconnectionCancelSchema = z.strictObject({ reason: requiredReason });
export type ReconnectionCancelInput = z.infer<typeof reconnectionCancelSchema>;
