import { describe, expect, it } from "vitest";
import {
  addDays,
  agingExportQuerySchema,
  collectionsExportQuerySchema,
  collectionsReportQuerySchema,
  periodStartOf,
  reportFileName,
  reportPeriods,
} from "./reports";

describe("reportFileName", () => {
  it("joins slug, date and format", () => {
    expect(reportFileName("ar-aging", "2026-10-10", "pdf")).toBe("ar-aging-2026-10-10.pdf");
    expect(reportFileName("ar-aging", "2026-10-10", "xlsx")).toBe("ar-aging-2026-10-10.xlsx");
  });
});

describe("agingExportQuerySchema", () => {
  it("needs a known format and keeps the aging filters", () => {
    const parsed = agingExportQuerySchema.parse({ format: "xlsx", serviceType: "internet" });
    expect(parsed).toEqual({ format: "xlsx", serviceType: "internet" });
    expect(agingExportQuerySchema.safeParse({}).success).toBe(false);
    expect(agingExportQuerySchema.safeParse({ format: "csv" }).success).toBe(false);
  });
});

describe("report periods", () => {
  it("adds days across month and year ends, and leap days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("starts weeks on Monday", () => {
    expect(periodStartOf("2026-10-10", "week")).toBe("2026-10-05"); // Saturday
    expect(periodStartOf("2026-10-05", "week")).toBe("2026-10-05"); // Monday
    expect(periodStartOf("2026-10-11", "week")).toBe("2026-10-05"); // Sunday
    expect(periodStartOf("2026-10-10", "month")).toBe("2026-10-01");
    expect(periodStartOf("2026-10-10", "year")).toBe("2026-01-01");
  });

  it("clips the first and last week to the range", () => {
    expect(reportPeriods("2026-10-01", "2026-10-15", "week")).toEqual([
      { start: "2026-10-01", end: "2026-10-04", label: "2026-10-01 – 2026-10-04" },
      { start: "2026-10-05", end: "2026-10-11", label: "2026-10-05 – 2026-10-11" },
      { start: "2026-10-12", end: "2026-10-15", label: "2026-10-12 – 2026-10-15" },
    ]);
  });

  it("lists days, months and years, including one-day ranges", () => {
    expect(reportPeriods("2026-10-10", "2026-10-10", "day")).toEqual([{ start: "2026-10-10", end: "2026-10-10", label: "2026-10-10" }]);
    expect(reportPeriods("2026-01-15", "2026-03-10", "month")).toEqual([
      { start: "2026-01-15", end: "2026-01-31", label: "January 2026" },
      { start: "2026-02-01", end: "2026-02-28", label: "February 2026" },
      { start: "2026-03-01", end: "2026-03-10", label: "March 2026" },
    ]);
    expect(reportPeriods("2025-06-01", "2026-10-10", "year").map((p) => p.label)).toEqual(["2025", "2026"]);
  });
});

describe("collectionsReportQuerySchema", () => {
  it("defaults to daily and checks the range", () => {
    expect(collectionsReportQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31" }).groupBy).toBe("day");
    expect(collectionsReportQuerySchema.safeParse({ from: "2026-10-31", to: "2026-10-01" }).success).toBe(false);
    expect(collectionsReportQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-31", groupBy: "hour" }).success).toBe(false);
  });

  it("refuses more than 400 rows but allows the same range grouped larger", () => {
    const twoYears = { from: "2025-01-01", to: "2026-12-31" };
    const daily = collectionsReportQuerySchema.safeParse({ ...twoYears, groupBy: "day" });
    expect(daily.success).toBe(false);
    expect(daily.error?.issues[0]?.path).toEqual(["groupBy"]);
    expect(collectionsReportQuerySchema.safeParse({ ...twoYears, groupBy: "week" }).success).toBe(true);
  });

  it("needs a format for exports", () => {
    expect(collectionsExportQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success).toBe(false);
    expect(collectionsExportQuerySchema.parse({ from: "2026-10-01", to: "2026-10-31", format: "pdf" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "day",
      format: "pdf",
    });
  });
});
