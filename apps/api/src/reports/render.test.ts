import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { type ReportDocument, formatCell, manilaTimestamp, rowCount } from "./document";
import { renderPdf } from "./render-pdf";
import { renderXlsx } from "./render-xlsx";

const meta = { generatedAt: new Date("2026-10-09T23:30:00Z"), generatedBy: "Demo Auditor" };

const doc: ReportDocument = {
  slug: "sample",
  title: "Sample Report",
  period: "As of 2026-10-10",
  fileDate: "2026-10-10",
  filters: [],
  figures: [{ label: "Collected", value: 123_456, kind: "money" }],
  tables: [
    {
      title: "Lines",
      columns: [
        { header: "Name", kind: "text", width: 3 },
        { header: "Count", kind: "count" },
        { header: "Amount", kind: "money" },
        { header: "Rate", kind: "percent" },
      ],
      rows: [["Juan Demo", 1200, 99_950, 1250]],
      totals: ["Total", 1200, 99_950, null],
    },
    { title: "Nothing here", columns: [{ header: "Name", kind: "text" }], rows: [], emptyMessage: "No exceptions." },
  ],
  orientation: "landscape",
};

describe("report document helpers", () => {
  it("formats time in Asia/Manila regardless of the server zone", () => {
    expect(manilaTimestamp(meta.generatedAt)).toBe("2026-10-10 07:30");
  });

  it("formats cells by kind from integers", () => {
    expect(formatCell(99_950, "money")).toBe("₱999.50");
    expect(formatCell(-5, "money")).toBe("-₱0.05");
    expect(formatCell(1250, "percent")).toBe("12.5%");
    expect(formatCell(1200, "count")).toBe("1,200");
    expect(formatCell(null, "money")).toBe("");
    expect(formatCell("2026-10-10", "date")).toBe("2026-10-10");
  });

  it("counts data rows across tables", () => {
    expect(rowCount(doc)).toBe(1);
  });
});

describe("renderers", () => {
  it("renders a PDF, including empty tables and landscape pages", async () => {
    const pdf = await renderPdf(doc, meta);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders typed XLSX cells: pesos and fractions for display, empty-table message", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(doc, meta)) as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Report")!;
    const rows = sheet.getRows(1, sheet.rowCount)!;

    const line = rows.find((r) => r.getCell(1).value === "Juan Demo")!;
    expect(line.getCell(2).value).toBe(1200);
    expect(line.getCell(3).value).toBe(999.5);
    expect(line.getCell(4).value).toBe(0.125);
    expect(line.getCell(4).numFmt).toBe("0.0%");

    const total = rows.find((r) => r.getCell(1).value === "Total")!;
    expect(total.font?.bold).toBe(true);
    expect(total.getCell(4).value).toBeNull();

    const texts = rows.map((r) => r.getCell(1).value);
    expect(texts).toContain("No exceptions.");
    expect(texts).toContain("All records (no filters)");
    expect(texts).toContain("Generated 2026-10-10 07:30 by Demo Auditor");
  });
});
