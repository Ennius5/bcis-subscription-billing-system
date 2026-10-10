import { describe, expect, it } from "vitest";
import { agingExportQuerySchema, reportFileName } from "./reports";

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
