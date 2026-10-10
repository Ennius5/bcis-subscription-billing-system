import { z } from "zod";
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
