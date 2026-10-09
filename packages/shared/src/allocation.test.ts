import { describe, expect, it } from "vitest";
import {
  allocateOldestFirst,
  compareOldestFirst,
  invoicePaymentStatus,
  planManualAllocation,
  type AllocationPlan,
  type OpenInvoice,
} from "./allocation";
import { parsePesos } from "./money";

const inv = (id: string, invoiceNumber: string, dueDate: string, balance: string): OpenInvoice => ({
  id,
  invoiceNumber,
  dueDate,
  balanceCentavos: parsePesos(balance),
});

const august = inv("aug", "INV-000001", "2026-08-05", "999");
const september = inv("sep", "INV-000002", "2026-09-05", "999");

const allocatedTotal = (plan: AllocationPlan) => plan.lines.reduce((sum, l) => sum + l.amountCentavos, 0);

describe("invoicePaymentStatus", () => {
  it("follows the amount paid", () => {
    expect(invoicePaymentStatus(99_900, 0)).toBe("unpaid");
    expect(invoicePaymentStatus(99_900, 50_000)).toBe("partially_paid");
    expect(invoicePaymentStatus(99_900, 99_900)).toBe("paid");
    expect(invoicePaymentStatus(0, 0)).toBe("paid");
  });

  it("refuses impossible amounts", () => {
    expect(() => invoicePaymentStatus(99_900, 100_000)).toThrow(RangeError);
    expect(() => invoicePaymentStatus(99_900, -1)).toThrow(RangeError);
    expect(() => invoicePaymentStatus(99_900, 0.5)).toThrow(RangeError);
  });
});

describe("AT-01: exact payment", () => {
  it("pays the invoice in full with nothing left over", () => {
    const plan = allocateOldestFirst(parsePesos("999"), [september]);
    expect(plan.lines).toEqual([
      { invoiceId: "sep", invoiceNumber: "INV-000002", balanceBeforeCentavos: 99_900, amountCentavos: 99_900, balanceAfterCentavos: 0 },
    ]);
    expect(plan.creditCentavos).toBe(0);
    expect(invoicePaymentStatus(99_900, plan.lines[0].amountCentavos)).toBe("paid");
  });
});

describe("AT-02: partial payment", () => {
  it("leaves ₱499 on the invoice", () => {
    const plan = allocateOldestFirst(parsePesos("500"), [september]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].amountCentavos).toBe(parsePesos("500"));
    expect(plan.lines[0].balanceAfterCentavos).toBe(parsePesos("499"));
    expect(plan.creditCentavos).toBe(0);
    expect(invoicePaymentStatus(99_900, plan.lines[0].amountCentavos)).toBe("partially_paid");
  });
});

describe("AT-03: advance payment", () => {
  it("pays the open month and keeps the rest as credit", () => {
    const october = inv("oct", "INV-000010", "2026-10-05", "1000");
    const plan = allocateOldestFirst(parsePesos("3000"), [october]);
    expect(plan.lines.map((l) => [l.invoiceId, l.amountCentavos])).toEqual([["oct", parsePesos("1000")]]);
    expect(plan.creditCentavos).toBe(parsePesos("2000"));
  });

  it("keeps everything as credit when nothing is owed", () => {
    expect(allocateOldestFirst(parsePesos("3000"), [])).toEqual({ lines: [], creditCentavos: parsePesos("3000") });
  });

  it("applies the credit later, one month at a time", () => {
    // The ₱2,000 credit meets the next two months as they are finalized.
    const november = inv("nov", "INV-000020", "2026-11-05", "1000");
    const first = allocateOldestFirst(parsePesos("2000"), [november]);
    expect(first.creditCentavos).toBe(parsePesos("1000"));
    const december = inv("dec", "INV-000030", "2026-12-05", "1000");
    const second = allocateOldestFirst(first.creditCentavos, [december]);
    expect(second.lines[0].balanceAfterCentavos).toBe(0);
    expect(second.creditCentavos).toBe(0);
  });
});

describe("AT-04: oldest-first arrears", () => {
  it("clears August, then puts the rest on September", () => {
    // Given newest first on purpose: the function must sort.
    const plan = allocateOldestFirst(parsePesos("1200"), [september, august]);
    expect(plan.lines.map((l) => [l.invoiceId, l.balanceAfterCentavos])).toEqual([
      ["aug", 0],
      ["sep", parsePesos("798")],
    ]);
    expect(plan.creditCentavos).toBe(0);
  });
});

describe("oldest-first ordering", () => {
  it("breaks a tie on due date with the invoice number (two services, same month)", () => {
    const internet = inv("b", "INV-000101", "2026-09-05", "999");
    const cable = inv("a", "INV-000100", "2026-09-05", "500");
    const plan = allocateOldestFirst(parsePesos("600"), [internet, cable]);
    expect(plan.lines.map((l) => [l.invoiceNumber, l.amountCentavos])).toEqual([
      ["INV-000100", parsePesos("500")],
      ["INV-000101", parsePesos("100")],
    ]);
    expect(compareOldestFirst(cable, internet)).toBeLessThan(0);
  });

  it("skips invoices with nothing left to pay and stops when the money runs out", () => {
    const paid = inv("paid", "INV-000000", "2026-07-05", "0");
    const plan = allocateOldestFirst(parsePesos("999"), [paid, august, september]);
    expect(plan.lines.map((l) => l.invoiceId)).toEqual(["aug"]);
  });

  it("does not reorder the caller's array", () => {
    const input = [september, august];
    allocateOldestFirst(parsePesos("100"), input);
    expect(input.map((i) => i.id)).toEqual(["sep", "aug"]);
  });

  it("refuses a zero, negative or fractional payment", () => {
    for (const amount of [0, -100, 10.5]) {
      expect(() => allocateOldestFirst(amount, [august])).toThrow(RangeError);
    }
  });
});

describe("no money is ever lost", () => {
  // A small deterministic PRNG, so a failure can be reproduced exactly.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("always splits the whole amount between invoices and credit, within each balance", () => {
    const random = mulberry32(20261009);
    for (let run = 0; run < 500; run += 1) {
      const invoices: OpenInvoice[] = Array.from({ length: Math.floor(random() * 6) }, (_, i) => ({
        id: `i${i}`,
        invoiceNumber: `INV-${String(i).padStart(6, "0")}`,
        dueDate: `2026-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-05`,
        balanceCentavos: Math.floor(random() * 200_000),
      }));
      const amount = 1 + Math.floor(random() * 500_000);
      const plan = allocateOldestFirst(amount, invoices);

      expect(allocatedTotal(plan) + plan.creditCentavos).toBe(amount);
      expect(plan.creditCentavos).toBeGreaterThanOrEqual(0);
      for (const l of plan.lines) {
        expect(l.amountCentavos).toBeGreaterThan(0);
        expect(l.balanceAfterCentavos).toBeGreaterThanOrEqual(0);
        expect(l.balanceBeforeCentavos - l.amountCentavos).toBe(l.balanceAfterCentavos);
      }
      // Credit only exists once every invoice is fully paid.
      const owed = invoices.reduce((sum, i) => sum + i.balanceCentavos, 0);
      expect(plan.creditCentavos).toBe(Math.max(0, amount - owed));
    }
  });
});

describe("planManualAllocation", () => {
  it("pays the chosen invoice and keeps the rest as credit", () => {
    const result = planManualAllocation(parsePesos("1200"), [{ invoiceId: "sep", amountCentavos: parsePesos("999") }], [
      august,
      september,
    ]);
    expect(result).toEqual({
      ok: true,
      plan: {
        lines: [
          { invoiceId: "sep", invoiceNumber: "INV-000002", balanceBeforeCentavos: 99_900, amountCentavos: 99_900, balanceAfterCentavos: 0 },
        ],
        creditCentavos: parsePesos("201"),
      },
    });
  });

  it("lists the lines oldest first whatever order they were chosen in", () => {
    const result = planManualAllocation(
      parsePesos("1000"),
      [
        { invoiceId: "sep", amountCentavos: parsePesos("400") },
        { invoiceId: "aug", amountCentavos: parsePesos("600") },
      ],
      [august, september],
    );
    expect(result.ok && result.plan.lines.map((l) => l.invoiceId)).toEqual(["aug", "sep"]);
  });

  it("refuses more than an invoice's balance", () => {
    const result = planManualAllocation(parsePesos("2000"), [{ invoiceId: "aug", amountCentavos: parsePesos("1000") }], [
      august,
    ]);
    expect(result).toEqual({ ok: false, problem: "INV-000001 only has a balance of ₱999.00.", invoiceId: "aug" });
  });

  it("refuses an invoice that is not open for this subscriber", () => {
    const paid = inv("paid", "INV-000000", "2026-07-05", "0");
    for (const invoiceId of ["someone-elses", "paid"]) {
      const result = planManualAllocation(parsePesos("100"), [{ invoiceId, amountCentavos: 100 }], [paid, august]);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses totals above the payment, duplicates and empty amounts", () => {
    const over = planManualAllocation(
      parsePesos("1000"),
      [
        { invoiceId: "aug", amountCentavos: parsePesos("999") },
        { invoiceId: "sep", amountCentavos: parsePesos("2") },
      ],
      [august, september],
    );
    expect(over).toEqual({ ok: false, problem: "The amounts applied to invoices are more than the payment." });
    const twice = planManualAllocation(
      parsePesos("1000"),
      [
        { invoiceId: "aug", amountCentavos: 100 },
        { invoiceId: "aug", amountCentavos: 100 },
      ],
      [august],
    );
    expect(twice.ok).toBe(false);
    expect(planManualAllocation(parsePesos("1000"), [{ invoiceId: "aug", amountCentavos: 0 }], [august]).ok).toBe(false);
  });
});
