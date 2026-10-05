import { describe, expect, it } from "vitest";
import {
  addCentavos,
  assertCentavos,
  formatPesos,
  parsePesos,
  subtractCentavos,
} from "./money";

describe("parsePesos", () => {
  it("parses whole and decimal amounts", () => {
    expect(parsePesos("999")).toBe(99900);
    expect(parsePesos("999.00")).toBe(99900);
    expect(parsePesos("0.1")).toBe(10);
    expect(parsePesos("1,000.50")).toBe(100050);
    expect(parsePesos("₱499.00")).toBe(49900);
  });

  it("rejects invalid input", () => {
    expect(() => parsePesos("")).toThrow();
    expect(() => parsePesos("abc")).toThrow();
    expect(() => parsePesos("1.234")).toThrow();
  });

  it("does not suffer float errors", () => {
    expect(addCentavos(parsePesos("0.10"), parsePesos("0.20"))).toBe(30);
  });
});

describe("arithmetic", () => {
  it("handles AT-04 style math: 1,200 payment against two 999 invoices", () => {
    const afterAugust = subtractCentavos(parsePesos("999"), parsePesos("999"));
    const septemberLeft = subtractCentavos(
      parsePesos("999"),
      subtractCentavos(parsePesos("1200"), parsePesos("999")),
    );
    expect(afterAugust).toBe(0);
    expect(septemberLeft).toBe(parsePesos("798"));
  });

  it("rejects non-integer centavos", () => {
    expect(() => assertCentavos(10.5)).toThrow(RangeError);
    expect(() => addCentavos(1.5, 2)).toThrow(RangeError);
  });
});

describe("formatPesos", () => {
  it("formats with grouping and two decimals", () => {
    expect(formatPesos(99900)).toBe("₱999.00");
    expect(formatPesos(123456789)).toBe("₱1,234,567.89");
    expect(formatPesos(5)).toBe("₱0.05");
    expect(formatPesos(-49900)).toBe("-₱499.00");
  });
});