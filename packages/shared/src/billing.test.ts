import { describe, expect, it } from "vitest";
import {
  addMonths,
  billingPeriodSchema,
  billingRunSchema,
  dueDateFor,
  invoiceDateFor,
  invoiceDisplayStatus,
  invoiceListQuerySchema,
  invoiceVoidSchema,
  isBillableInPeriod,
  periodBounds,
  periodOf,
} from "./billing";

describe("billing periods", () => {
  it("accepts YYYY-MM only", () => {
    expect(billingPeriodSchema.safeParse("2026-09").success).toBe(true);
    for (const bad of ["2026-9", "2026-13", "2026-00", "202609", "2026-09-01", "Sept 2026"]) {
      expect(billingPeriodSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("finds the first and last day of a month, leap years included", () => {
    expect(periodBounds("2026-09")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(periodBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(periodBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("moves between months across year ends", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-09", 0)).toBe("2026-09");
    expect(periodOf("2026-09-17")).toBe("2026-09");
  });
});

describe("invoice dates (advance billing)", () => {
  it("dates the invoice on the 1st and makes it due on the billing day of the same month", () => {
    expect(invoiceDateFor("2026-09")).toBe("2026-09-01");
    expect(dueDateFor("2026-09", 5)).toBe("2026-09-05");
    expect(dueDateFor("2026-02", 28)).toBe("2026-02-28");
    expect(dueDateFor("2026-09", 1)).toBe("2026-09-01");
  });

  it("refuses billing days outside 1-28", () => {
    expect(() => dueDateFor("2026-09", 0)).toThrow();
    expect(() => dueDateFor("2026-09", 29)).toThrow();
  });
});

describe("which months an account is billed for (no proration)", () => {
  it("bills every month from the month billing starts, in full", () => {
    expect(isBillableInPeriod("2026-09-17", "2026-09")).toBe(true); // mid-month start: full September
    expect(isBillableInPeriod("2026-09-17", "2026-10")).toBe(true);
    expect(isBillableInPeriod("2026-09-17", "2026-08")).toBe(false);
    expect(isBillableInPeriod("2026-10-01", "2026-09")).toBe(false); // staff skipped September
  });

  it("never bills an account that has not started billing", () => {
    expect(isBillableInPeriod(null, "2026-09")).toBe(false);
  });
});

describe("invoiceDisplayStatus", () => {
  const invoice = { status: "unpaid", dueDate: "2026-09-05", totalCentavos: 99_900, paidCentavos: 0 };

  it("shows an open invoice as overdue only after its due date", () => {
    expect(invoiceDisplayStatus(invoice, "2026-09-05")).toBe("unpaid"); // due today is not overdue
    expect(invoiceDisplayStatus(invoice, "2026-09-06")).toBe("overdue");
    expect(invoiceDisplayStatus({ ...invoice, status: "partially_paid", paidCentavos: 50_000 }, "2026-10-01")).toBe(
      "overdue",
    );
  });

  it("never shows paid, void or draft invoices as overdue", () => {
    for (const status of ["paid", "void", "draft", "credited"]) {
      expect(invoiceDisplayStatus({ ...invoice, status }, "2027-01-01")).toBe(status);
    }
  });
});

describe("billing schemas", () => {
  it("validates a billing run and rejects extra fields", () => {
    expect(billingRunSchema.parse({ period: " 2026-09 " })).toEqual({ period: "2026-09" });
    expect(billingRunSchema.safeParse({ period: "2026-09", force: true }).success).toBe(false);
  });

  it("requires a reason to void", () => {
    expect(invoiceVoidSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(invoiceVoidSchema.parse({ reason: " Billed in error " }).reason).toBe("Billed in error");
  });

  it("parses list filters, overdue included", () => {
    const q = invoiceListQuerySchema.parse({ page: "2", status: "overdue", period: "2026-09", search: "" });
    expect(q).toMatchObject({ page: 2, pageSize: 25, status: "overdue", period: "2026-09" });
    expect(q.search).toBeUndefined();
  });
});
