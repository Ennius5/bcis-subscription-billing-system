import { z } from "zod";

/*
 * Billing rules (Phase 4), as decided for this project:
 * - One invoice per service account per calendar month ("period", written YYYY-MM).
 * - Advance billing: the invoice for a month is dated the 1st and due on the account's
 *   billing day in that same month (September, billing day 5 -> due September 5).
 * - No proration: an account is billed a full month for every month from the month its
 *   billing starts. Staff set "billing starts" to the next month's 1st to skip a partial month.
 * - Generating creates drafts; finalizing numbers them and posts them to the ledger.
 */

export const INVOICE_STATUSES = ["draft", "unpaid", "partially_paid", "paid", "void", "credited"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** What screens show: the stored status, or "overdue" when an open invoice is past due. */
export const INVOICE_DISPLAY_STATUSES = [...INVOICE_STATUSES, "overdue"] as const;
export type InvoiceDisplayStatus = (typeof INVOICE_DISPLAY_STATUSES)[number];

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const billingPeriodSchema = z.string().trim().regex(PERIOD_PATTERN, "Enter the billing month as YYYY-MM.");
export type BillingPeriod = string;

const pad = (n: number) => String(n).padStart(2, "0");

function parsePeriod(period: BillingPeriod): { year: number; month: number } {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) throw new Error(`Invalid billing period: ${period}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** First and last calendar day of the month, as "YYYY-MM-DD". */
export function periodBounds(period: BillingPeriod): { start: string; end: string } {
  const { year, month } = parsePeriod(period);
  // Day 0 of the next month is the last day of this one (UTC, so no time zone shifts).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" -> "September 2026", the wording used on invoice lines and the ledger. */
export function periodLabel(period: BillingPeriod): string {
  const { year, month } = parsePeriod(period);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** The period a calendar date ("YYYY-MM-DD") falls in. */
export function periodOf(date: string): BillingPeriod {
  return date.slice(0, 7);
}

/** The period `count` months after (or before, when negative) the given one. */
export function addMonths(period: BillingPeriod, count: number): BillingPeriod {
  const { year, month } = parsePeriod(period);
  const index = year * 12 + (month - 1) + count;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Advance billing: invoices are dated the 1st of their month. */
export function invoiceDateFor(period: BillingPeriod): string {
  return periodBounds(period).start;
}

/** Due on the account's billing day in the same month. Billing days are 1-28, so every month has one. */
export function dueDateFor(period: BillingPeriod, billingDay: number): string {
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) {
    throw new Error(`Invalid billing day: ${billingDay}`);
  }
  return `${period}-${pad(billingDay)}`;
}

/** No proration: billed in full for every month from the month billing starts. */
export function isBillableInPeriod(billingStartDate: string | null, period: BillingPeriod): boolean {
  return billingStartDate !== null && periodOf(billingStartDate) <= period;
}

/** Overdue is derived, never stored: an open invoice whose due date has passed. */
export function invoiceDisplayStatus(
  invoice: { status: string; dueDate: string; totalCentavos: number; paidCentavos: number; adjustedCentavos?: number },
  today: string,
): InvoiceDisplayStatus {
  const open = invoice.status === "unpaid" || invoice.status === "partially_paid";
  const effective = invoice.totalCentavos + (invoice.adjustedCentavos ?? 0);
  if (open && invoice.paidCentavos < effective && invoice.dueDate < today) return "overdue";
  return invoice.status as InvoiceStatus;
}

/* ------------------------------- Schemas ------------------------------- */

/** Generate drafts for a month, or finalize that month's drafts. */
export const billingRunSchema = z.strictObject({ period: billingPeriodSchema });
export type BillingRunInput = z.infer<typeof billingRunSchema>;

export const invoiceVoidSchema = z.strictObject({
  reason: z.string().trim().min(3, "A reason is required.").max(200),
});
export type InvoiceVoidInput = z.infer<typeof invoiceVoidSchema>;

const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });

/** Ledger or Statement of Account date range. Both ends are optional and inclusive. */
export const ledgerQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((r) => !r.from || !r.to || r.from <= r.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const INVOICE_PAGE_SIZE_DEFAULT = 25;
export const INVOICE_PAGE_SIZE_MAX = 100;

// Query-string values arrive as text, so numbers are coerced. A blank search is no search.
export const invoiceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(INVOICE_PAGE_SIZE_MAX).default(INVOICE_PAGE_SIZE_DEFAULT),
  period: billingPeriodSchema.optional(),
  status: z.enum(INVOICE_DISPLAY_STATUSES).optional(),
  subscriberId: z.uuid().optional(),
  serviceAccountId: z.uuid().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => (s === "" ? undefined : s)),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
