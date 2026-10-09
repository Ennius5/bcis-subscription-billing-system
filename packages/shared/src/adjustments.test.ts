import { describe, expect, it } from "vitest";
import { adjustmentCreateSchema, adjustmentProblem, categoriesFor } from "./adjustments";
import { invoicePaymentStatus } from "./allocation";
import { invoiceDisplayStatus } from "./billing";

describe("invoicePaymentStatus with adjustments", () => {
  it("uses the effective total (billed total plus adjustments)", () => {
    expect(invoicePaymentStatus(99_900, 0, -20_000)).toBe("unpaid");
    expect(invoicePaymentStatus(99_900, 79_900, -20_000)).toBe("paid");
    expect(invoicePaymentStatus(99_900, 99_900, 10_000)).toBe("partially_paid");
  });

  it("is CREDITED only when credits brought the total to zero", () => {
    expect(invoicePaymentStatus(99_900, 0, -99_900)).toBe("credited");
    // Part paid, the rest credited: money came in, so it is PAID.
    expect(invoicePaymentStatus(99_900, 50_000, -49_900)).toBe("paid");
    // A zero-rate invoice was never credited: still PAID, as when it was finalized.
    expect(invoicePaymentStatus(0, 0, 0)).toBe("paid");
  });

  it("refuses credits beyond the total and payments beyond the effective total", () => {
    expect(() => invoicePaymentStatus(99_900, 0, -100_000)).toThrow(RangeError);
    expect(() => invoicePaymentStatus(99_900, 90_000, -20_000)).toThrow(RangeError);
  });
});

describe("invoiceDisplayStatus with adjustments", () => {
  const base = { status: "partially_paid", dueDate: "2026-09-05", totalCentavos: 99_900, paidCentavos: 79_900 };

  it("is overdue while something is still owed after the due date", () => {
    expect(invoiceDisplayStatus({ ...base, adjustedCentavos: 10_000 }, "2026-09-20")).toBe("overdue");
  });

  it("is not overdue when credits leave nothing owed", () => {
    expect(invoiceDisplayStatus({ ...base, status: "paid", adjustedCentavos: -20_000 }, "2026-09-20")).toBe("paid");
  });
});

describe("adjustmentProblem", () => {
  it("caps a credit at the open balance", () => {
    expect(adjustmentProblem("credit", 50_000, 50_000)).toBeNull();
    expect(adjustmentProblem("credit", 50_001, 50_000)).toBe("A credit cannot be more than the open balance of ₱500.00.");
    expect(adjustmentProblem("credit", 1, 0)).toMatch(/Nothing is owed/);
  });

  it("does not cap a debit", () => {
    expect(adjustmentProblem("debit", 1_000_000, 0)).toBeNull();
  });
});

describe("adjustmentCreateSchema", () => {
  const base = { kind: "credit", category: "service_outage", amountCentavos: 20_000, reason: "Outage Sept 3-5" };

  it("accepts a credit with a credit category", () => {
    expect(adjustmentCreateSchema.parse(base)).toEqual(base);
  });

  it("refuses a category of the other kind", () => {
    const result = adjustmentCreateSchema.safeParse({ ...base, category: "penalty" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["category"]);
    expect(adjustmentCreateSchema.safeParse({ ...base, kind: "debit", category: "penalty" }).success).toBe(true);
  });

  it("requires a reason and a positive whole amount", () => {
    expect(adjustmentCreateSchema.safeParse({ ...base, reason: " " }).success).toBe(false);
    expect(adjustmentCreateSchema.safeParse({ ...base, amountCentavos: 0 }).success).toBe(false);
    expect(adjustmentCreateSchema.safeParse({ ...base, amountCentavos: 10.5 }).success).toBe(false);
  });

  it("lists the categories each kind may use", () => {
    expect(categoriesFor("credit")).toContain("goodwill");
    expect(categoriesFor("debit")).not.toContain("goodwill");
    expect(categoriesFor("debit")).toContain("reconnection_fee");
  });
});
