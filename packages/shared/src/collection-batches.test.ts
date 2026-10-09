import { describe, expect, it } from "vitest";
import {
  allowedBatchTransitions,
  batchCreateSchema,
  batchReconcileSchema,
  batchTransitionProblem,
  canRecordCollections,
  canRecordRemittances,
  cashVariance,
  COLLECTION_BATCH_STATUSES,
  dueSnapshot,
  fieldCollectionCreateSchema,
  uncollectedCentavos,
} from "./collection-batches";

const ID = "8d0f8a43-1c1e-4a55-9d7a-2f3b5c6d7e8f";

describe("batch lifecycle", () => {
  it("follows open -> in progress -> submitted -> remitted -> reconciled -> closed", () => {
    expect(batchTransitionProblem("open", "in_progress")).toBeNull();
    expect(batchTransitionProblem("in_progress", "submitted")).toBeNull();
    expect(batchTransitionProblem("submitted", "remitted")).toBeNull();
    expect(batchTransitionProblem("remitted", "reconciled")).toBeNull();
    expect(batchTransitionProblem("reconciled", "closed")).toBeNull();
  });

  it("lets a submitted batch with nothing handed over go straight to reconciled", () => {
    expect(batchTransitionProblem("submitted", "reconciled")).toBeNull();
  });

  it("allows cancelling only before submission", () => {
    expect(batchTransitionProblem("open", "cancelled")).toBeNull();
    expect(batchTransitionProblem("in_progress", "cancelled")).toBeNull();
    expect(batchTransitionProblem("submitted", "cancelled")).not.toBeNull();
  });

  it("cannot close without reconciling first", () => {
    expect(batchTransitionProblem("remitted", "closed")).toMatch(/cannot be made closed/);
  });

  it("treats closed and cancelled as final", () => {
    expect(allowedBatchTransitions("closed")).toEqual([]);
    expect(allowedBatchTransitions("cancelled")).toEqual([]);
  });

  it("explains a no-op move", () => {
    expect(batchTransitionProblem("open", "open")).toBe("The batch is already open.");
  });

  it("records collections only in progress, remittances only after submission", () => {
    const collecting = COLLECTION_BATCH_STATUSES.filter(canRecordCollections);
    const remitting = COLLECTION_BATCH_STATUSES.filter(canRecordRemittances);
    expect(collecting).toEqual(["in_progress"]);
    expect(remitting).toEqual(["submitted", "remitted"]);
  });
});

describe("dueSnapshot", () => {
  const today = "2026-10-10";

  it("splits open balances into current and past-due arrears", () => {
    const s = dueSnapshot(
      [
        { dueDate: "2026-09-05", openCentavos: 99_900 },
        { dueDate: "2026-10-05", openCentavos: 50_000 },
        { dueDate: "2026-10-10", openCentavos: 99_900 }, // due today is not yet overdue
      ],
      0,
      today,
    );
    expect(s).toEqual({
      currentCentavos: 99_900,
      arrearsCentavos: 149_900,
      creditCentavos: 0,
      totalDueCentavos: 249_800,
    });
  });

  it("subtracts unapplied credit from the total due", () => {
    const s = dueSnapshot([{ dueDate: "2026-10-15", openCentavos: 99_900 }], 20_000, today);
    expect(s.totalDueCentavos).toBe(79_900);
  });

  it("never shows a negative total due", () => {
    const s = dueSnapshot([{ dueDate: "2026-10-15", openCentavos: 10_000 }], 50_000, today);
    expect(s.totalDueCentavos).toBe(0);
  });

  it("is all zeros with nothing open", () => {
    expect(dueSnapshot([], 0, today).totalDueCentavos).toBe(0);
  });
});

describe("cashVariance", () => {
  it("AT-07: ₱20,000 collected and ₱20,000 remitted is balanced", () => {
    expect(cashVariance(2_000_000, 2_000_000)).toEqual({ differenceCentavos: 0, kind: "balanced" });
  });

  it("AT-08: ₱20,000 collected and ₱19,500 remitted is a ₱500 shortage", () => {
    expect(cashVariance(2_000_000, 1_950_000)).toEqual({ differenceCentavos: -50_000, kind: "shortage" });
  });

  it("more remitted than collected is an overage", () => {
    expect(cashVariance(2_000_000, 2_010_000)).toEqual({ differenceCentavos: 10_000, kind: "overage" });
  });
});

describe("uncollectedCentavos", () => {
  it("is what was due less cash and non-cash collected", () => {
    expect(uncollectedCentavos(500_000, 300_000, 50_000)).toBe(150_000);
  });

  it("does not go below zero when subscribers paid more than was due", () => {
    expect(uncollectedCentavos(100_000, 150_000, 0)).toBe(0);
  });
});

describe("batch schemas", () => {
  it("requires a collector and a date", () => {
    expect(batchCreateSchema.safeParse({ collectionDate: "2026-10-10" }).success).toBe(false);
    expect(batchCreateSchema.safeParse({ collectorId: ID, collectionDate: "2026-10-10" }).success).toBe(true);
  });

  it("needs a cheque number for a cheque but not for cash", () => {
    const base = { subscriberId: ID, amountCentavos: 99_900 };
    expect(fieldCollectionCreateSchema.safeParse({ ...base, method: "cheque" }).success).toBe(false);
    expect(fieldCollectionCreateSchema.safeParse({ ...base, method: "cash" }).success).toBe(true);
  });

  it("does not accept GCash as a field collection", () => {
    const r = fieldCollectionCreateSchema.safeParse({ subscriberId: ID, amountCentavos: 100, method: "gcash" });
    expect(r.success).toBe(false);
  });

  it("AT-08: a shortage cannot be reconciled without a reason", () => {
    expect(batchReconcileSchema.safeParse({ differenceCentavos: -50_000 }).success).toBe(false);
    expect(
      batchReconcileSchema.safeParse({ differenceCentavos: -50_000, varianceReason: "Collector lost ₱500" }).success,
    ).toBe(true);
  });

  it("a balanced batch needs no reason", () => {
    expect(batchReconcileSchema.safeParse({ differenceCentavos: 0 }).success).toBe(true);
  });
});
