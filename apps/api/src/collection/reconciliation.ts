import { eq, sql } from "drizzle-orm";
import { cashVariance, formatPesos, type BatchCloseInput, type BatchReconcileInput } from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { collectionBatches } from "../db/schema";
import { BatchError, ensureTransition, getBatch, lockBatch, type BatchDetail } from "./batches";

/** "₱500.00 shortage", "₱0.00 (balanced)": the words the user saw on screen. */
function describeDifference(differenceCentavos: number): string {
  if (differenceCentavos === 0) return "₱0.00 (balanced)";
  return `${formatPesos(Math.abs(differenceCentavos))} ${differenceCentavos < 0 ? "shortage" : "overage"}`;
}

/**
 * Reconciles a submitted or remitted batch (AT-07, AT-08): compares the cash the collector
 * remitted with the cash collections posted on the batch and freezes both, the difference,
 * its kind and the reason. The reconciler sends the difference they were shown; if the
 * figures changed since (a collection reversed, a remittance voided on another PC), the
 * server refuses so nobody reconciles on figures they did not see. A shortage or overage
 * needs a reason. No subscriber's ledger is touched: subscribers already got credit for
 * what they paid the collector.
 */
export async function reconcileBatch(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: BatchReconcileInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    ensureTransition(batch, "reconciled");

    const { money } = await getBatch(tx, batchId);
    const expected = money.cashCollectedCentavos;
    const remitted = money.remittedCentavos;
    const variance = cashVariance(expected, remitted);

    if (input.differenceCentavos !== variance.differenceCentavos) {
      throw new BatchError(
        "DIFFERENCE_CHANGED",
        409,
        `The figures changed: the difference is now ${describeDifference(variance.differenceCentavos)}. Review the batch and confirm again.`,
      );
    }
    const reason = input.varianceReason?.trim() || null;
    if (variance.kind !== "balanced" && (reason?.length ?? 0) < 3) {
      throw new BatchError("VARIANCE_REASON_REQUIRED", 422, `Explain the ${variance.kind} before reconciling.`);
    }

    await tx
      .update(collectionBatches)
      .set({
        status: "reconciled",
        expectedCashCentavos: expected,
        remittedCashCentavos: remitted,
        differenceCentavos: variance.differenceCentavos,
        varianceKind: variance.kind,
        varianceReason: reason,
        reconciledAt: sql`now()`,
        reconciledByUserId: actorUserId,
      })
      .where(eq(collectionBatches.id, batchId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.reconcile",
      entityType: "collection_batch",
      entityId: batchId,
      reason,
      oldValues: { status: batch.status },
      newValues: {
        status: "reconciled",
        batchNumber: batch.batchNumber,
        expectedCashCentavos: expected,
        remittedCashCentavos: remitted,
        differenceCentavos: variance.differenceCentavos,
        varianceKind: variance.kind,
        chequeCollectedCentavos: money.chequeCollectedCentavos,
        paidElsewhereCentavos: money.paidElsewhereCentavos,
        uncollectedCentavos: money.uncollectedCentavos,
      },
    });
  });
  return getBatch(db, batchId);
}

/**
 * Closes a reconciled batch: the authorized confirmation (collection.close) the spec asks
 * for. The closer confirms the recorded difference; a mismatch is refused, so a batch with
 * a shortage is never closed by someone who believes it balanced (AT-08). Closed is final.
 */
export async function closeBatch(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: BatchCloseInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    ensureTransition(batch, "closed");
    if (input.differenceCentavos !== batch.differenceCentavos) {
      throw new BatchError(
        "DIFFERENCE_CHANGED",
        409,
        `This batch was reconciled with a difference of ${describeDifference(batch.differenceCentavos!)}. Confirm that figure to close it.`,
      );
    }
    await tx
      .update(collectionBatches)
      .set({ status: "closed", closedAt: sql`now()`, closedByUserId: actorUserId })
      .where(eq(collectionBatches.id, batchId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.close",
      entityType: "collection_batch",
      entityId: batchId,
      oldValues: { status: "reconciled" },
      newValues: {
        status: "closed",
        batchNumber: batch.batchNumber,
        differenceCentavos: batch.differenceCentavos,
        varianceKind: batch.varianceKind,
      },
    });
  });
  return getBatch(db, batchId);
}
