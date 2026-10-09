import { describe, expect, it } from "vitest";
import {
  agingBucket,
  agingTotals,
  countPastGrace,
  daysPastDue,
  isSuspensionCandidate,
  receivableSettingsUpdateSchema,
  reconnectionPaymentProblem,
  reconnectionRequestSchema,
  reconnectionTransitionProblem,
  serviceSuspendSchema,
} from "./receivables";

const TODAY = "2026-10-09";
const settings = { gracePeriodDays: 7, suspensionThresholdInvoices: 1 };

describe("daysPastDue", () => {
  it("is 0 on the due date and counts across month ends", () => {
    expect(daysPastDue(TODAY, TODAY)).toBe(0);
    expect(daysPastDue("2026-09-30", TODAY)).toBe(9);
    expect(daysPastDue("2026-10-15", TODAY)).toBe(-6);
    expect(daysPastDue("2026-02-28", "2026-03-01")).toBe(1);
  });
});

describe("aging buckets", () => {
  it("puts each boundary in the right bucket", () => {
    expect(agingBucket("2026-10-09", TODAY)).toBe("current");
    expect(agingBucket("2026-10-08", TODAY)).toBe("days_1_30"); // 1 day
    expect(agingBucket("2026-09-09", TODAY)).toBe("days_1_30"); // 30 days
    expect(agingBucket("2026-09-08", TODAY)).toBe("days_31_60"); // 31 days
    expect(agingBucket("2026-08-10", TODAY)).toBe("days_31_60"); // 60 days
    expect(agingBucket("2026-08-09", TODAY)).toBe("days_61_90"); // 61 days
    expect(agingBucket("2026-07-11", TODAY)).toBe("days_61_90"); // 90 days
    expect(agingBucket("2026-07-10", TODAY)).toBe("days_90_plus"); // 91 days
  });

  it("sums open balances per bucket without losing any", () => {
    const invoices = [
      { dueDate: "2026-10-15", openCentavos: 99_900 },
      { dueDate: "2026-09-15", openCentavos: 50_000 },
      { dueDate: "2026-09-05", openCentavos: 99_900 },
      { dueDate: "2026-06-05", openCentavos: 1 },
    ];
    const totals = agingTotals(invoices, TODAY);
    expect(totals).toEqual({ current: 99_900, days_1_30: 50_000, days_31_60: 99_900, days_61_90: 0, days_90_plus: 1 });
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(invoices.reduce((a, i) => a + i.openCentavos, 0));
  });
});

describe("suspension candidates", () => {
  it("counts an invoice only after the grace period has passed", () => {
    // Due Oct 2, grace 7: still in grace on Oct 9, past it on Oct 10.
    const invoices = [{ dueDate: "2026-10-02", openCentavos: 99_900 }];
    expect(countPastGrace(invoices, "2026-10-09", 7)).toBe(0);
    expect(countPastGrace(invoices, "2026-10-10", 7)).toBe(1);
  });

  it("ignores invoices with nothing left to pay", () => {
    expect(countPastGrace([{ dueDate: "2026-08-05", openCentavos: 0 }], TODAY, 7)).toBe(0);
  });

  it("needs an active account and at least the threshold", () => {
    const invoices = [
      { dueDate: "2026-08-05", openCentavos: 99_900 },
      { dueDate: "2026-09-05", openCentavos: 99_900 },
    ];
    expect(isSuspensionCandidate("active", invoices, TODAY, settings)).toBe(true);
    expect(isSuspensionCandidate("active", invoices, TODAY, { ...settings, suspensionThresholdInvoices: 3 })).toBe(false);
    expect(isSuspensionCandidate("suspended", invoices, TODAY, settings)).toBe(false);
    expect(isSuspensionCandidate("terminated", invoices, TODAY, settings)).toBe(false);
  });
});

describe("qualifying payment", () => {
  it("qualifies once no past-due invoice is open, even with the current bill unpaid", () => {
    expect(reconnectionPaymentProblem([{ dueDate: "2026-10-15", openCentavos: 99_900 }], TODAY)).toBeNull();
    expect(reconnectionPaymentProblem([{ dueDate: "2026-10-09", openCentavos: 99_900 }], TODAY)).toBeNull();
  });

  it("names how many past-due invoices remain", () => {
    expect(reconnectionPaymentProblem([{ dueDate: "2026-10-08", openCentavos: 1 }], TODAY)).toBe(
      "1 past-due invoice is still unpaid.",
    );
    expect(
      reconnectionPaymentProblem(
        [
          { dueDate: "2026-08-05", openCentavos: 1 },
          { dueDate: "2026-09-05", openCentavos: 1 },
        ],
        TODAY,
      ),
    ).toBe("2 past-due invoices are still unpaid.");
  });
});

describe("reconnection transitions", () => {
  it("allows the forward moves, including handing over to another technician", () => {
    expect(reconnectionTransitionProblem("requested", "assigned")).toBeNull();
    expect(reconnectionTransitionProblem("requested", "completed")).toBeNull();
    expect(reconnectionTransitionProblem("assigned", "assigned")).toBeNull();
    expect(reconnectionTransitionProblem("assigned", "cancelled")).toBeNull();
  });

  it("treats completed and cancelled as final", () => {
    expect(reconnectionTransitionProblem("completed", "cancelled")).toBe("This reconnection is already completed.");
    expect(reconnectionTransitionProblem("cancelled", "assigned")).toBe("This reconnection is already cancelled.");
    expect(reconnectionTransitionProblem("assigned", "requested")).not.toBeNull();
  });
});

describe("schemas", () => {
  it("requires a reason and approver to suspend", () => {
    expect(serviceSuspendSchema.safeParse({ reason: "Unpaid", approvedBy: "Owner" }).success).toBe(true);
    expect(serviceSuspendSchema.safeParse({ reason: "Unpaid" }).success).toBe(false);
    expect(serviceSuspendSchema.safeParse({ approvedBy: "Owner" }).success).toBe(false);
  });

  it("requires a waiver reason only when the fee is waived", () => {
    expect(reconnectionRequestSchema.parse({}).waiveFee).toBe(false);
    expect(reconnectionRequestSchema.safeParse({ waiveFee: true }).success).toBe(false);
    expect(reconnectionRequestSchema.safeParse({ waiveFee: true, feeWaiverReason: "Our outage" }).success).toBe(true);
    expect(reconnectionRequestSchema.safeParse({ feeWaiverReason: "No waiver" }).success).toBe(false);
  });

  it("validates the settings and needs a change besides the reason", () => {
    expect(receivableSettingsUpdateSchema.safeParse({ gracePeriodDays: 10 }).success).toBe(true);
    expect(receivableSettingsUpdateSchema.safeParse({ reason: "Policy" }).success).toBe(false);
    expect(receivableSettingsUpdateSchema.safeParse({ gracePeriodDays: -1 }).success).toBe(false);
    expect(receivableSettingsUpdateSchema.safeParse({ suspensionThresholdInvoices: 0 }).success).toBe(false);
    expect(receivableSettingsUpdateSchema.safeParse({ gracePeriodDays: 1.5 }).success).toBe(false);
  });
});
