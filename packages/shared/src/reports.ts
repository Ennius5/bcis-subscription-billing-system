import { z } from "zod";
import { addMonths, billingPeriodSchema, ledgerQuerySchema, periodBounds, periodLabel, periodOf } from "./billing";
import { agingQuerySchema } from "./receivables";

/** Reports are exported as PDF (to read and print) or XLSX (to work with the figures). */
export const REPORT_EXPORT_FORMATS = ["pdf", "xlsx"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

export const REPORT_EXPORT_CONTENT_TYPES: Record<ReportExportFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const reportExportFormatSchema = z.enum(REPORT_EXPORT_FORMATS, {
  error: "Choose PDF or Excel.",
});

/** "ar-aging-2026-10-10.pdf": the report's slug, the date it describes, the format. */
export function reportFileName(slug: string, date: string, format: ReportExportFormat): string {
  return `${slug}-${date}.${format}`;
}

/** The aging screen's filters plus the format. */
export const agingExportQuerySchema = agingQuerySchema.extend({ format: reportExportFormatSchema });
export type AgingExportQuery = z.infer<typeof agingExportQuerySchema>;

/* --------------------------- Report periods --------------------------- */

/*
 * Report dates are calendar dates (YYYY-MM-DD, Asia/Manila). Weeks run Monday to Sunday.
 * A range is split into whole periods, and the first and last are clipped to the range, so
 * "week" over Oct 1-15 gives Oct 1-4, Oct 5-11, Oct 12-15.
 */
export const REPORT_GROUPINGS = ["day", "week", "month", "year"] as const;
export type ReportGrouping = (typeof REPORT_GROUPINGS)[number];

export const REPORT_GROUPING_LABELS: Record<ReportGrouping, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Annual",
};

/** Upper bound on rows in a period table (about a year of days). */
export const REPORT_MAX_PERIODS = 400;

export interface ReportPeriod {
  start: string;
  end: string;
  label: string;
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** First day of the period containing `date` (Monday for weeks). */
export function periodStartOf(date: string, groupBy: ReportGrouping): string {
  switch (groupBy) {
    case "day":
      return date;
    case "week":
      return addDays(date, -((utc(date).getUTCDay() + 6) % 7));
    case "month":
      return `${periodOf(date)}-01`;
    case "year":
      return `${date.slice(0, 4)}-01-01`;
  }
}

function periodEndOf(start: string, groupBy: ReportGrouping): string {
  switch (groupBy) {
    case "day":
      return start;
    case "week":
      return addDays(start, 6);
    case "month":
      return periodBounds(periodOf(start)).end;
    case "year":
      return `${start.slice(0, 4)}-12-31`;
  }
}

function periodName(start: string, end: string, groupBy: ReportGrouping): string {
  switch (groupBy) {
    case "day":
      return start;
    case "week":
      return `${start} – ${end}`;
    case "month":
      return periodLabel(periodOf(start));
    case "year":
      return start.slice(0, 4);
  }
}

/** The periods covering from..to (both inclusive), clipped to the range, oldest first. */
export function reportPeriods(from: string, to: string, groupBy: ReportGrouping): ReportPeriod[] {
  const periods: ReportPeriod[] = [];
  for (let start = periodStartOf(from, groupBy); start <= to; start = addDays(periodEndOf(start, groupBy), 1)) {
    const clippedStart = start < from ? from : start;
    const end = periodEndOf(start, groupBy);
    const clippedEnd = end > to ? to : end;
    periods.push({ start: clippedStart, end: clippedEnd, label: periodName(clippedStart, clippedEnd, groupBy) });
    if (periods.length > REPORT_MAX_PERIODS) break; // the schema refuses this; stop counting early
  }
  return periods;
}

const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });

/** A date range (both ends inclusive) split into day/week/month/year rows. */
export const collectionsReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    groupBy: z.enum(REPORT_GROUPINGS, { error: "Choose daily, weekly, monthly or annual." }).default("day"),
  })
  .refine((q) => q.from <= q.to, { message: "The start date must be on or before the end date.", path: ["to"] })
  .refine((q) => q.from > q.to || reportPeriods(q.from, q.to, q.groupBy).length <= REPORT_MAX_PERIODS, {
    message: `That range has more than ${REPORT_MAX_PERIODS} rows. Choose a shorter range or a larger grouping.`,
    path: ["groupBy"],
  });
export type CollectionsReportQuery = z.infer<typeof collectionsReportQuerySchema>;

export const collectionsExportQuerySchema = collectionsReportQuerySchema.and(z.object({ format: reportExportFormatSchema }));
export type CollectionsExportQuery = z.infer<typeof collectionsExportQuerySchema>;

/* ------------------------- Month-range reports ------------------------- */

/*
 * Billing reports work in billing months (YYYY-MM). Billed = finalized, non-void invoices of
 * that billing month; adjustments count in the month they were posted (their ledger date).
 */
export const REPORT_MAX_MONTHS = 60;

/** Every month from..to, both inclusive, oldest first. */
export function monthsInRange(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = from; m <= to && months.length <= REPORT_MAX_MONTHS; m = addMonths(m, 1)) months.push(m);
  return months;
}

const monthRangeShape = { from: billingPeriodSchema, to: billingPeriodSchema };

function checkMonthRange<T extends z.ZodType<{ from: string; to: string }>>(schema: T) {
  return schema
    .refine((q) => q.from <= q.to, { message: "The start month must be on or before the end month.", path: ["to"] })
    .refine((q) => q.from > q.to || monthsInRange(q.from, q.to).length <= REPORT_MAX_MONTHS, {
      message: `Choose at most ${REPORT_MAX_MONTHS} months.`,
      path: ["from"],
    });
}

export const billingVsCollectionQuerySchema = checkMonthRange(z.object(monthRangeShape));
export type BillingVsCollectionQuery = z.infer<typeof billingVsCollectionQuerySchema>;
export const billingVsCollectionExportQuerySchema = checkMonthRange(
  z.object({ ...monthRangeShape, format: reportExportFormatSchema }),
);

export const REVENUE_DIMENSIONS = ["plan", "service_type", "area"] as const;
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];
export const REVENUE_DIMENSION_LABELS: Record<RevenueDimension, string> = {
  plan: "Plan",
  service_type: "Service type",
  area: "Area",
};

const revenueShape = {
  ...monthRangeShape,
  dimension: z.enum(REVENUE_DIMENSIONS, { error: "Choose plan, service type or area." }).default("plan"),
};
export const revenueQuerySchema = checkMonthRange(z.object(revenueShape));
export type RevenueQuery = z.infer<typeof revenueQuerySchema>;
export const revenueExportQuerySchema = checkMonthRange(z.object({ ...revenueShape, format: reportExportFormatSchema }));

/* ------------------------- Statement of Account ------------------------- */

/**
 * The same optional range as the profile's ledger: no start date means from the first entry
 * (opening balance 0); no end date means as of today.
 */
export const statementExportQuerySchema = ledgerQuerySchema.and(z.object({ format: reportExportFormatSchema }));
export type StatementExportQuery = z.infer<typeof statementExportQuerySchema>;
