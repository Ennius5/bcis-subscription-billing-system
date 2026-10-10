import { formatPesos, formatRate } from "@bcis/shared";

/**
 * How a column's values are stored and shown. Money is integer centavos, percentages are
 * basis points (12.5% = 1250), counts are integers, text and dates (YYYY-MM-DD) are strings.
 */
export type ColumnKind = "text" | "date" | "count" | "money" | "percent";

export interface ReportColumn {
  header: string;
  kind: ColumnKind;
  /** Relative width in the PDF (default 1); XLSX sizes columns from the same number. */
  width?: number;
}

export type ReportCell = string | number | null;

export interface ReportTable {
  title?: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** Optional totals row, same length as columns. */
  totals?: ReportCell[];
  emptyMessage?: string;
}

/** One key figure above the tables, e.g. "Total open: ₱12,345.00". */
export interface ReportFigure {
  label: string;
  value: ReportCell;
  kind: ColumnKind;
}

/**
 * Everything a report export shows, independent of the file format. Each report builds one
 * of these from the same data its screen shows; the PDF and XLSX renderers only lay it out.
 */
export interface ReportDocument {
  /** File name stem and audit entity id, e.g. "ar-aging". */
  slug: string;
  title: string;
  /** The date or period the figures describe, e.g. "As of 2026-10-10". */
  period: string;
  /** The date used in the file name. */
  fileDate: string;
  /** Applied filters as readable lines; empty means everything. */
  filters: { label: string; value: string }[];
  figures: ReportFigure[];
  tables: ReportTable[];
  orientation?: "portrait" | "landscape";
  notes?: string[];
}

/** Who exported it and when, printed in the header/footer. */
export interface ExportMeta {
  generatedAt: Date;
  generatedBy: string;
}

const MANILA_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Manila",
  dateStyle: "short",
  timeStyle: "short",
});

/** "2026-10-10 14:03" in Asia/Manila, whatever the server's own time zone is. */
export function manilaTimestamp(date: Date): string {
  return MANILA_TIME.format(date);
}

/** Text form of a cell, used by the PDF and for anything that isn't a typed XLSX cell. */
export function formatCell(value: ReportCell, kind: ColumnKind): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  switch (kind) {
    case "money":
      return formatPesos(value);
    case "percent":
      return formatRate(value);
    case "count":
      return value.toLocaleString("en-PH");
    default:
      return String(value);
  }
}

export function isNumericKind(kind: ColumnKind): boolean {
  return kind === "count" || kind === "money" || kind === "percent";
}

/** Data rows across all tables, recorded in the export's audit entry. */
export function rowCount(doc: ReportDocument): number {
  return doc.tables.reduce((n, t) => n + t.rows.length, 0);
}
