import { describe, expect, it } from "vitest";
import { tryParsePesos } from "./money";

describe("tryParsePesos", () => {
  it("parses valid peso strings into centavos", () => {
    expect(tryParsePesos("999")).toBe(99900);
    expect(tryParsePesos("999.5")).toBe(99950);
    expect(tryParsePesos("1,000.50")).toBe(100050);
  });

  it("returns null for invalid input", () => {
    expect(tryParsePesos("")).toBeNull();
    expect(tryParsePesos("abc")).toBeNull();
    expect(tryParsePesos("12.345")).toBeNull();
    expect(tryParsePesos("1e3")).toBeNull();
  });
});