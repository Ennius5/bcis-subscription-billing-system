import { z } from "zod";
import { REPORT_PAGE_SIZE_DEFAULT, REPORT_PAGE_SIZE_MAX, reportExportFormatSchema } from "./reports";

/*
 * Audit actions are "<entity>.<verb>" (payment.reverse, invoice.void, ...). For filtering and
 * the user activity report they are grouped into areas of work. A pattern ending in "." is a
 * prefix; any other pattern is one exact action. Anything unmatched is "other".
 */
export const AUDIT_CATEGORIES = [
  "subscribers",
  "services",
  "billing",
  "payments",
  "collections",
  "administration",
  "exports",
  "other",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  subscribers: "Subscribers",
  services: "Plans & services",
  billing: "Billing",
  payments: "Payments",
  collections: "Collections",
  administration: "Administration",
  exports: "Exports",
  other: "Other",
};

export const AUDIT_CATEGORY_PATTERNS: Record<Exclude<AuditCategory, "other">, readonly string[]> = {
  subscribers: ["subscriber."],
  services: ["service_account.", "plan."],
  billing: ["billing.", "invoice."],
  payments: ["payment.", "gcash."],
  collections: ["collection_batch.", "collector.", "collection_area."],
  administration: ["settings.", "user.", "backup."],
  exports: ["report.export", "soa.export"],
};

const matches = (action: string, pattern: string) =>
  pattern.endsWith(".") ? action.startsWith(pattern) : action === pattern;

export function auditCategory(action: string): AuditCategory {
  for (const [category, patterns] of Object.entries(AUDIT_CATEGORY_PATTERNS)) {
    if (patterns.some((p) => matches(action, p))) return category as AuditCategory;
  }
  return "other";
}

const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });
const orderedRange = { message: "The start date must be on or before the end date.", path: ["to"] };

/** Audit log viewer filters. Dates are Asia/Manila calendar days of occurred_at, both inclusive. */
export const auditLogQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    actorUserId: z.uuid().optional(),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    action: z.string().trim().min(1).max(80).optional(),
    entityType: z.string().trim().min(1).max(40).optional(),
    entityId: z.string().trim().min(1).max(80).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(REPORT_PAGE_SIZE_MAX).default(REPORT_PAGE_SIZE_DEFAULT),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, orderedRange);
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** User activity over a date range: logins and audited actions per user. */
export const userActivityQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, orderedRange);
export type UserActivityQuery = z.infer<typeof userActivityQuerySchema>;
export const userActivityExportQuerySchema = z
  .object({ from: isoDate, to: isoDate, format: reportExportFormatSchema })
  .refine((q) => q.from <= q.to, orderedRange);
