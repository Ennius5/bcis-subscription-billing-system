import ExcelJS from "exceljs";
import {
  type ColumnKind,
  type ExportMeta,
  type ReportCell,
  type ReportDocument,
  formatCell,
  isNumericKind,
  manilaTimestamp,
} from "./document";

const NAVY = "FF0F2747";
const MUTED = "FF64748B";
const HEADER_FILL = "FFEEF2F7";

const NUMBER_FORMATS: Partial<Record<ColumnKind, string>> = {
  money: '"₱"#,##0.00;-"₱"#,##0.00',
  percent: "0.0%",
  count: "#,##0",
};

/**
 * Typed spreadsheet value. Centavos become pesos and basis points become fractions here, for
 * display and summing in the spreadsheet only; the authoritative figures stay integers.
 */
function cellValue(value: ReportCell, kind: ColumnKind): string | number | null {
  if (value === null || typeof value === "string") return value;
  if (kind === "money") return value / 100;
  if (kind === "percent") return value / 10_000;
  if (kind === "count") return value;
  return formatCell(value, kind);
}

/**
 * One worksheet laid out like the PDF: title block, filters, key figures, then each table
 * with its header and totals rows.
 */
export async function renderXlsx(doc: ReportDocument, meta: ExportMeta): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BCIS";
  workbook.created = meta.generatedAt;
  const sheet = workbook.addWorksheet("Report");

  const columnCount = Math.max(2, doc.figures.length, ...doc.tables.map((t) => t.columns.length));
  sheet.columns = Array.from({ length: columnCount }, (_, i) => {
    const widest = Math.max(1, ...doc.tables.map((t) => t.columns[i]?.width ?? 1));
    return { width: Math.min(60, 12 + widest * 6) };
  });

  const note = (text: string, color = MUTED) => {
    const row = sheet.addRow([text]);
    row.getCell(1).font = { size: 9, color: { argb: color } };
  };

  sheet.addRow(["Bukidnon Cable and Internet Services"]).getCell(1).font = { size: 9, color: { argb: MUTED } };
  sheet.addRow([doc.title]).getCell(1).font = { size: 14, bold: true, color: { argb: NAVY } };
  sheet.addRow([doc.period]);
  for (const f of doc.filters) note(`${f.label}: ${f.value}`);
  if (doc.filters.length === 0) note("All records (no filters)");
  note(`Generated ${manilaTimestamp(meta.generatedAt)} by ${meta.generatedBy}`);
  sheet.addRow([]);

  if (doc.figures.length) {
    const labels = sheet.addRow(doc.figures.map((f) => f.label));
    labels.font = { size: 9, color: { argb: MUTED } };
    const values = sheet.addRow(doc.figures.map((f) => cellValue(f.value, f.kind)));
    values.font = { bold: true };
    doc.figures.forEach((f, i) => {
      const format = NUMBER_FORMATS[f.kind];
      if (format) values.getCell(i + 1).numFmt = format;
    });
    sheet.addRow([]);
  }

  for (const table of doc.tables) {
    if (table.title) sheet.addRow([table.title]).getCell(1).font = { bold: true, color: { argb: NAVY } };

    const header = sheet.addRow(table.columns.map((c) => c.header));
    header.eachCell((cell, i) => {
      cell.font = { bold: true, color: { argb: NAVY } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      if (isNumericKind(table.columns[i - 1]!.kind)) cell.alignment = { horizontal: "right" };
    });

    const addDataRow = (cells: ReportCell[], bold: boolean) => {
      const row = sheet.addRow(table.columns.map((c, i) => cellValue(cells[i] ?? null, c.kind)));
      table.columns.forEach((c, i) => {
        const format = NUMBER_FORMATS[c.kind];
        if (format) row.getCell(i + 1).numFmt = format;
      });
      if (bold) row.font = { bold: true };
    };

    if (table.rows.length === 0) note(table.emptyMessage ?? "No records.");
    for (const r of table.rows) addDataRow(r, false);
    if (table.totals) addDataRow(table.totals, true);
    sheet.addRow([]);
  }

  for (const text of doc.notes ?? []) note(text);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
