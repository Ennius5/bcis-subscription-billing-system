import { describe, expect, it } from "vitest";
import {
  allowedServiceTransitions,
  SERVICE_ACCOUNT_STATUSES,
  serviceAccountCreateSchema,
  serviceAccountUpdateSchema,
  serviceCollectorChangeSchema,
  servicePlanChangeSchema,
  serviceRateChangeSchema,
  serviceStatusChangeProblem,
  serviceStatusChangeSchema,
} from "./service-accounts";

const UUID = "00000000-0000-4000-8000-000000000001";

describe("service account status rules", () => {
  it("allows the documented transitions", () => {
    expect(serviceStatusChangeProblem("pending", "active")).toBeNull();
    expect(serviceStatusChangeProblem("pending", "terminated")).toBeNull();
    expect(serviceStatusChangeProblem("active", "terminated")).toBeNull();
    expect(serviceStatusChangeProblem("suspended", "terminated")).toBeNull();
  });

  it("leaves suspending and reconnecting to their own actions", () => {
    expect(serviceStatusChangeProblem("active", "suspended")).toBe("Use Suspend, which records the reason and approval.");
    expect(serviceStatusChangeProblem("suspended", "active")).toBe(
      "A suspended service is restored through a reconnection.",
    );
  });

  it("does not suspend an account that was never activated", () => {
    expect(serviceStatusChangeProblem("pending", "suspended")).not.toBeNull();
  });

  it("does not return an account to pending", () => {
    expect(serviceStatusChangeProblem("active", "pending")).not.toBeNull();
  });

  it("treats terminated as final", () => {
    expect(allowedServiceTransitions("terminated")).toEqual([]);
    for (const to of SERVICE_ACCOUNT_STATUSES) {
      expect(serviceStatusChangeProblem("terminated", to)).not.toBeNull();
    }
  });

  it("rejects changing to the current status", () => {
    expect(serviceStatusChangeProblem("active", "active")).toMatch(/already active/);
  });
});

describe("serviceAccountCreateSchema", () => {
  it("accepts a plan and installation address, everything else optional", () => {
    const parsed = serviceAccountCreateSchema.parse({ planId: UUID, installationAddressId: UUID });
    expect(parsed.billingDay).toBeUndefined();
  });

  it("does not accept a rate: it comes from the plan", () => {
    const parsed = serviceAccountCreateSchema.parse({
      planId: UUID,
      installationAddressId: UUID,
      rateCentavos: 1,
    });
    expect(parsed).not.toHaveProperty("rateCentavos");
  });

  it("rejects a billing day outside 1 to 28", () => {
    const result = serviceAccountCreateSchema.safeParse({
      planId: UUID,
      installationAddressId: UUID,
      billingDay: 29,
    });
    expect(result.success).toBe(false);
  });
});

describe("serviceAccountUpdateSchema", () => {
  it("requires a change besides the reason", () => {
    expect(serviceAccountUpdateSchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(serviceAccountUpdateSchema.safeParse({ billingDay: 10 }).success).toBe(true);
  });

  it("rejects fields that have their own endpoints", () => {
    expect(serviceAccountUpdateSchema.safeParse({ status: "active" }).success).toBe(false);
    expect(serviceAccountUpdateSchema.safeParse({ planId: UUID }).success).toBe(false);
    expect(serviceAccountUpdateSchema.safeParse({ currentRateCentavos: 100 }).success).toBe(false);
  });
});

describe("serviceStatusChangeSchema", () => {
  it("requires a reason", () => {
    expect(serviceStatusChangeSchema.safeParse({ status: "active" }).success).toBe(false);
    expect(serviceStatusChangeSchema.safeParse({ status: "active", reason: "Installed" }).success).toBe(true);
  });

  it("validates dates as YYYY-MM-DD", () => {
    expect(
      serviceStatusChangeSchema.safeParse({ status: "active", reason: "Installed", effectiveDate: "2026-02-30" })
        .success,
    ).toBe(false);
    expect(
      serviceStatusChangeSchema.safeParse({ status: "active", reason: "Installed", effectiveDate: "2026-10-01" })
        .success,
    ).toBe(true);
  });

  it("allows a billing start date only when activating, and not before activation", () => {
    expect(
      serviceStatusChangeSchema.safeParse({
        status: "suspended",
        reason: "Unpaid",
        billingStartDate: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(
      serviceStatusChangeSchema.safeParse({
        status: "active",
        reason: "Installed",
        effectiveDate: "2026-10-05",
        billingStartDate: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(
      serviceStatusChangeSchema.safeParse({
        status: "active",
        reason: "Installed",
        effectiveDate: "2026-10-05",
        billingStartDate: "2026-11-01",
      }).success,
    ).toBe(true);
  });
});

describe("rate, plan and collector changes", () => {
  it("rate change needs integer centavos and a reason", () => {
    expect(serviceRateChangeSchema.safeParse({ rateCentavos: 99900, reason: "Promo ended" }).success).toBe(true);
    expect(serviceRateChangeSchema.safeParse({ rateCentavos: 999.5, reason: "Promo" }).success).toBe(false);
    expect(serviceRateChangeSchema.safeParse({ rateCentavos: -1, reason: "Promo" }).success).toBe(false);
    expect(serviceRateChangeSchema.safeParse({ rateCentavos: 99900 }).success).toBe(false);
  });

  it("plan change makes the rate optional", () => {
    expect(servicePlanChangeSchema.safeParse({ planId: UUID, reason: "Upgrade" }).success).toBe(true);
  });

  it("collector change requires the field so clearing it is explicit", () => {
    expect(serviceCollectorChangeSchema.safeParse({}).success).toBe(false);
    expect(serviceCollectorChangeSchema.safeParse({ assignedCollectorId: null }).success).toBe(true);
  });
});
