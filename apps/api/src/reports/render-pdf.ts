import { createRequire } from "node:module";
import path from "node:path";
import pdfMake from "pdfmake";
import type { Content, TableCell } from "pdfmake/interfaces";
import {
  type ExportMeta,
  type ReportDocument,
  type ReportTable,
  formatCell,
  isNumericKind,
  manilaTimestamp,
} from "./document";

const NAVY = "#0f2747";
const MUTED = "#64748b";
const RULE = "#cbd5e1";
const HEADER_FILL = "#eef2f7";

// pdfmake's bundled Roboto has the peso sign (U+20B1), so formatPesos output prints as is.
const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve("pdfmake/package.json")), "fonts", "Roboto");

pdfMake.addFonts({
  Roboto: {
    normal: path.join(FONT_DIR, "Roboto-Regular.ttf"),
    bold: path.join(FONT_DIR, "Roboto-Medium.ttf"),
    italics: path.join(FONT_DIR, "Roboto-Italic.ttf"),
    bolditalics: path.join(FONT_DIR, "Roboto-MediumItalic.ttf"),
  },
});
// Report text comes from the database; never let a document definition fetch URLs or read
// files other than the fonts.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(FONT_DIR));

function tableContent(table: ReportTable): Content[] {
  const header: TableCell[] = table.columns.map((c) => ({
    text: c.header,
    style: "th",
    alignment: isNumericKind(c.kind) ? "right" : "left",
  }));
  const toRow = (cells: (string | number | null)[], bold: boolean): TableCell[] =>
    table.columns.map((c, i) => ({
      text: formatCell(cells[i] ?? null, c.kind),
      alignment: isNumericKind(c.kind) ? "right" : "left",
      bold,
    }));

  const body: TableCell[][] = [header];
  if (table.rows.length === 0) {
    body.push([
      { text: table.emptyMessage ?? "No records.", colSpan: table.columns.length, color: MUTED, italics: true },
      ...table.columns.slice(1).map(() => ({})),
    ]);
  } else {
    body.push(...table.rows.map((r) => toRow(r, false)));
  }
  if (table.totals) body.push(toRow(table.totals, true));

  const totalWidth = table.columns.reduce((t, c) => t + (c.width ?? 1), 0);
  const lastRow = body.length;
  const hasTotals = table.totals !== undefined;
  return [
    ...(table.title ? [{ text: table.title, style: "h2" } as Content] : []),
    {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: table.columns.map((c) => `${(((c.width ?? 1) * 100) / totalWidth).toFixed(2)}%`),
        body,
      },
      layout: {
        fillColor: (row: number) => (row === 0 ? HEADER_FILL : null),
        hLineWidth: (i: number) => (i === 0 || i === 1 || i === lastRow || (hasTotals && i === lastRow - 1) ? 0.8 : 0.3),
        hLineColor: () => RULE,
        vLineWidth: () => 0,
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
      margin: [0, 0, 0, 12],
    },
  ];
}

/** A4 PDF: title block, filters, key figures, tables; page numbers and who exported it in the footer. */
export async function renderPdf(doc: ReportDocument, meta: ExportMeta): Promise<Buffer> {
  const filterText = doc.filters.length
    ? doc.filters.map((f) => `${f.label}: ${f.value}`).join("   ·   ")
    : "All records (no filters)";

  const content: Content[] = [
    { text: "Bukidnon Cable and Internet Services", style: "org" },
    { text: doc.title, style: "h1" },
    { text: doc.period, style: "period" },
    { text: filterText, style: "filters" },
  ];
  if (doc.figures.length) {
    content.push({
      table: {
        widths: doc.figures.map(() => "*"),
        body: [
          doc.figures.map((f) => ({ text: f.label, style: "figureLabel" })),
          doc.figures.map((f) => ({ text: formatCell(f.value, f.kind), style: "figureValue" })),
        ],
      },
      layout: "noBorders",
      margin: [0, 0, 0, 12],
    });
  }
  for (const table of doc.tables) content.push(...tableContent(table));
  for (const note of doc.notes ?? []) content.push({ text: note, style: "note" });

  const stamp = `Generated ${manilaTimestamp(meta.generatedAt)} by ${meta.generatedBy}`;
  return pdfMake
    .createPdf({
      pageSize: "A4",
      pageOrientation: doc.orientation ?? "portrait",
      pageMargins: [36, 36, 36, 40],
      info: { title: doc.title, author: "BCIS", creator: "BCIS Billing and Collection System" },
      content,
      footer: (page, pages) => ({
        columns: [
          { text: stamp, alignment: "left" },
          { text: `Page ${page} of ${pages}`, alignment: "right" },
        ],
        margin: [36, 12, 36, 0],
        fontSize: 7,
        color: MUTED,
      }),
      defaultStyle: { font: "Roboto", fontSize: 8.5, color: "#111827" },
      styles: {
        org: { fontSize: 8, color: MUTED },
        h1: { fontSize: 15, bold: true, color: NAVY, margin: [0, 2, 0, 1] },
        period: { fontSize: 9.5, margin: [0, 0, 0, 2] },
        filters: { fontSize: 8, color: MUTED, margin: [0, 0, 0, 10] },
        h2: { fontSize: 10.5, bold: true, color: NAVY, margin: [0, 4, 0, 4] },
        th: { bold: true, color: NAVY },
        figureLabel: { fontSize: 7.5, color: MUTED },
        figureValue: { fontSize: 11, bold: true },
        note: { fontSize: 7.5, color: MUTED, margin: [0, 2, 0, 0] },
      },
    })
    .getBuffer();
}
