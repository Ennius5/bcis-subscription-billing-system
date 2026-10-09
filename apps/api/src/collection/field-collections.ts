import { and, eq, sql } from "drizzle-orm";
import {
  canRecordCollections,
  canRecordRemittances,
  COLLECTION_BATCH_STATUS_LABELS,
  type CollectionBatchStatus,
  type FieldCollectionCreateInput,
  type RemittanceCreateInput,
  type RemittanceVoidInput,
} from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { batchAccounts, collectionBatches, collectorRemittances } from "../db/schema";
import { getPayment, postPaymentInTx, type PaymentDetail } from "../payments/service";
import { BatchError, getBatch, lockBatch, type BatchDetail, type BatchRow } from "./batches";

const statusLabel = (batch: BatchRow) => COLLECTION_BATCH_STATUS_LABELS[batch.status as CollectionBatchStatus].toLowerCase();

/* --------------------------- Field collections --------------------------- */

/**
 * Records a payment the collector took in the field, from the collector's tally. It is a
 * real payment (receipt number, oldest-first allocation, ledger credit), posted now, so the
 * subscriber's balance drops even if the collector later comes back short: a shortage is
 * the collector's, never the subscriber's. Only while the batch is in progress, and only
 * for a subscriber on the batch. The payment date defaults to the batch's collection date.
 *
 * Locks the batch, then (inside postPaymentInTx) the subscriber. Nothing locks them in the
 * opposite order, so two PCs cannot deadlock here.
 */
export async function recordFieldCollection(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: FieldCollectionCreateInput,
): Promise<PaymentDetail> {
  const paymentId = await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!canRecordCollections(batch.status as CollectionBatchStatus)) {
      throw new BatchError(
        "BATCH_NOT_COLLECTING",
        409,
        `Collections can only be recorded while the batch is in progress (it is ${statusLabel(batch)}).`,
      );
    }
    const [onBatch] = await tx
      .select({ id: batchAccounts.id })
      .from(batchAccounts)
      .where(and(eq(batchAccounts.batchId, batchId), eq(batchAccounts.subscriberId, input.subscriberId)));
    if (!onBatch) {
      throw new BatchError("NOT_ON_BATCH", 409, "That subscriber is not on this batch. Add them to the batch first.");
    }

    return postPaymentInTx(tx, actorUserId, {
      subscriberId: input.subscriberId,
      method: input.method,
      amountCentavos: input.amountCentavos,
      paymentDate: input.paymentDate ?? batch.collectionDate,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
      fieldCollection: { batchId, batchNumber: batch.batchNumber, collectorId: batch.collectorId },
    });
  });
  return getPayment(db, paymentId);
}

/* ------------------------------ Remittances ------------------------------ */

/**
 * Records cash the collector handed over. Allowed after submission and before
 * reconciliation; the first one moves the batch to remitted. A collector who brings the
 * rest later gets a second entry.
 */
export async function recordRemittance(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: RemittanceCreateInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!canRecordRemittances(batch.status as CollectionBatchStatus)) {
      throw new BatchError(
        "BATCH_NOT_REMITTING",
        409,
        `Remittances can only be recorded after the batch is submitted and before it is reconciled (it is ${statusLabel(batch)}).`,
      );
    }
    const [remittance] = await tx
      .insert(collectorRemittances)
      .values({
        batchId,
        collectorId: batch.collectorId,
        amountCentavos: input.amountCentavos,
        notes: input.notes ?? null,
        receivedByUserId: actorUserId,
      })
      .returning({ id: collectorRemittances.id });
    if (batch.status === "submitted") {
      await tx.update(collectionBatches).set({ status: "remitted" }).where(eq(collectionBatches.id, batchId));
    }
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.remit",
      entityType: "collection_batch",
      entityId: batchId,
      oldValues: batch.status === "submitted" ? { status: "submitted" } : null,
      newValues: {
        batchNumber: batch.batchNumber,
        remittanceId: remittance!.id,
        amountCentavos: input.amountCentavos,
        ...(batch.status === "submitted" && { status: "remitted" }),
      },
    });
  });
  return getBatch(db, batchId);
}

/**
 * Voids a wrongly entered remittance, with a reason. The entry stays visible. Only before
 * reconciliation. The batch stays remitted even if every entry ends up voided: what counts
 * at reconciliation is the sum of entries that are not voided.
 */
export async function voidRemittance(
  db: Db,
  actorUserId: string,
  batchId: string,
  remittanceId: string,
  input: RemittanceVoidInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!canRecordRemittances(batch.status as CollectionBatchStatus)) {
      throw new BatchError(
        "BATCH_NOT_REMITTING",
        409,
        `Remittances can only be voided before the batch is reconciled (it is ${statusLabel(batch)}).`,
      );
    }
    const [remittance] = await tx
      .select()
      .from(collectorRemittances)
      .where(and(eq(collectorRemittances.id, remittanceId), eq(collectorRemittances.batchId, batchId)))
      .for("update");
    if (!remittance) throw new BatchError("REMITTANCE_NOT_FOUND", 404, "Remittance not found on this batch.");
    if (remittance.voidedAt) throw new BatchError("REMITTANCE_VOIDED", 409, "This remittance is already voided.");

    await tx
      .update(collectorRemittances)
      .set({ voidedAt: sql`now()`, voidedByUserId: actorUserId, voidReason: input.reason })
      .where(eq(collectorRemittances.id, remittanceId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.void_remittance",
      entityType: "collection_batch",
      entityId: batchId,
      reason: input.reason,
      oldValues: { remittanceId, amountCentavos: remittance.amountCentavos, voided: false },
      newValues: { voided: true },
    });
  });
  return getBatch(db, batchId);
}
