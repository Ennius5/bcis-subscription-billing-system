import { describe, expect, it } from "vitest";
import { planAttributeProblem, planCreateSchema, planUpdateSchema } from "./plans";

const internet = {
  code: "inet-10",
  name: "Internet 10 Mbps",
  serviceType: "internet",
  priceCentavos: 99900,
  speedMbps: 10,
};

describe("planCreateSchema", () => {
  it("accepts a valid internet plan, upper-cases the code and defaults fees to 0", () => {
    const plan = planCreateSchema.parse(internet);
    expect(plan.code).toBe("INET-10");
    expect(plan.installationFeeCentavos).toBe(0);
    expect(plan.reconnectionFeeCentavos).toBe(0);
  });

  it("rejects a negative price", () => {
    expect(planCreateSchema.safeParse({ ...internet, priceCentavos: -1 }).success).toBe(false);
  });

  it("rejects fractional centavos", () => {
    expect(planCreateSchema.safeParse({ ...internet, priceCentavos: 999.5 }).success).toBe(false);
  });

  it("rejects a price above the cap", () => {
    expect(planCreateSchema.safeParse({ ...internet, priceCentavos: 100_000_001 }).success).toBe(false);
  });

  it("rejects an unknown service type", () => {
    expect(planCreateSchema.safeParse({ ...internet, serviceType: "satellite" }).success).toBe(false);
  });

  it("rejects an invalid code", () => {
    expect(planCreateSchema.safeParse({ ...internet, code: "a b" }).success).toBe(false);
  });

  it("rejects a channel count on an internet plan", () => {
    const result = planCreateSchema.safeParse({ ...internet, channelCount: 50 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("channelCount"))).toBe(true);
    }
  });

  it("rejects a speed on a cable plan", () => {
    const cable = { ...internet, code: "CAB-1", serviceType: "cable", speedMbps: 10, channelCount: 80 };
    expect(planCreateSchema.safeParse(cable).success).toBe(false);
  });

  it("allows both speed and channel count on a combo plan", () => {
    const combo = { ...internet, code: "COMBO-1", serviceType: "combo", channelCount: 80 };
    expect(planCreateSchema.safeParse(combo).success).toBe(true);
  });
});

describe("planAttributeProblem", () => {
  it("returns null for valid combinations", () => {
    expect(planAttributeProblem("internet", 10, null)).toBeNull();
    expect(planAttributeProblem("cable", null, 80)).toBeNull();
    expect(planAttributeProblem("combo", 10, 80)).toBeNull();
  });


});

describe("planUpdateSchema", () => {
  it("accepts a partial update with a reason", () => {
    const r = planUpdateSchema.safeParse({ priceCentavos: 109900, reason: "annual adjustment" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty update and a reason-only update", () => {
    expect(planUpdateSchema.safeParse({}).success).toBe(false);
    expect(planUpdateSchema.safeParse({ reason: "nothing changed" }).success).toBe(false);
  });

  it("rejects attempts to change code or service type", () => {
    expect(planUpdateSchema.safeParse({ code: "NEW" }).success).toBe(false);
    expect(planUpdateSchema.safeParse({ serviceType: "cable" }).success).toBe(false);
  });
});