import { and, eq, sql } from "drizzle-orm";
import {
  batchCreateSchema,
  collectorCreateSchema,
  fieldCollectionCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, invoices } from "../db/schema";
import { reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { createBatch, dispatchBatch, getBatch, submitBatch } from "./batches";
import { recordFieldCollection, recordRemittance, voidRemittance } from "./field-collections";
import { closeBatch, reconcileBatch } from "./reconciliation";
import { createCollector } from "./service";

const { db, pool } = createTestDb();

let actorId: string;
let collectorId: string;
let collectionDate: string;
let alpha: { id: string; serviceId: string };
let bravo: { id: string; serviceId: string };
let cycleId: string;
let invoiceNo = 0;

async function makeSubscriber(fullName: string, planId: string) {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay: 5,
      assignedCollectorId: collectorId,
      address: { line1: "Purok 7", barangay: "Kalasungay", city: "Malaybalay" },
    }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  return { id: subscriber.id, serviceId: service.id };
}

/** A finalized, unpaid ₱10,000.00 invoice (large, so ₱20,000 is collected across two subscribers). */
async function openInvoice(who: { id: string; serviceId: string }) {
  invoiceNo += 1;
  await pool.query(
    `INSERT INTO invoices (billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, total_centavos, created_by_user_id, status, invoice_number, finalized_at, finalized_by_user_id)
     VALUES ($1, $2, $3, '2000-01-01', '2000-01-31', '2000-01-01', '2000-01-05', 1000000, $4, 'unpaid', $5, now(), $4)`,
    [cycleId, who.id, who.serviceId, actorId, `INV-R${String(invoiceNo).padStart(5, "0")}`],
  );
}

const collect = (batchId: string, who: { id: string }, amountCentavos: number, method = "cash") =>
  recordFieldCollection(
    db,
    actorId,
    batchId,
    fieldCollectionCreateSchema.parse({
      subscriberId: who.id,
      method,
      amountCentavos,
      referenceNumber: method === "cheque" ? "CHQ-1" : null,
    }),
  );

/** AT-07/AT-08 setup: ₱20,000.00 cash collected (₱10,000 each from two subscribers), submitted. */
async function submittedWith20k() {
  const { batch } = await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }));
  await dispatchBatch(db, actorId, batch.id);
  await collect(batch.id, alpha, 1_000_000);
  await collect(batch.id, bravo, 1_000_000);
  await submitBatch(db, actorId, batch.id);
  return batch;
}

const auditFor = (action: string, entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "reconcile_actor", "Passw0rd!test", "collection_supervisor");
  const dates = await pool.query<{ earlier: string }>(`SELECT (CURRENT_DATE - 1)::text AS earlier`);
  collectionDate = dates.rows[0]!.earlier;
  collectorId = (await createCollector(db, actorId, collectorCreateSchema.parse({ code: "COL-R1", fullName: "Remit Collector" }))).id;
  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-recon", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  alpha = await makeSubscriber("Alpha Reconcile", planId);
  bravo = await makeSubscriber("Bravo Reconcile", planId);
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2000-01-01', '2000-01-31', $1) RETURNING id`,
    [actorId],
  );
  cycleId = cycle.rows[0]!.id;
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE collection_batches, batch_accounts, collector_remittances, payments, payment_allocations,
        payment_reversals, invoices, ledger_entries CASCADE`,
  );
  await openInvoice(alpha);
  await openInvoice(bravo);
});

afterAll(async () => {
  await pool.end();
});

describe("AT-07: collector balanced remittance", () => {
  it("₱20,000 collected and ₱20,000 remitted: difference ₱0, reconciles and closes", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_000_000 });

    const reconciled = await reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciliation).toEqual({
      expectedCashCentavos: 2_000_000,
      remittedCashCentavos: 2_000_000,
      differenceCentavos: 0,
      varianceKind: "balanced",
      varianceReason: null,
    });
    expect(reconciled.reconciled?.byName).toBeTruthy();

    const closed = await closeBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    expect(closed.status).toBe("closed");
    expect(closed.closed).not.toBeNull();

    expect(await auditFor("collection_batch.reconcile", batch.id)).toHaveLength(1);
    const close = await auditFor("collection_batch.close", batch.id);
    expect(close[0]?.newValues).toMatchObject({ status: "closed", differenceCentavos: 0, varianceKind: "balanced" });
  });
});

describe("AT-08: collector shortage", () => {
  it("₱20,000 collected and ₱19,500 remitted: ₱500 shortage shown, recorded with a reason", async () => {
    const batch = await submittedWith20k();
    const remitted = await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_950_000 });
    expect(remitted.money.cashCollectedCentavos - remitted.money.remittedCentavos).toBe(50_000);

    const reconciled = await reconcileBatch(db, actorId, batch.id, {
      differenceCentavos: -50_000,
      varianceReason: "Collector says ₱500 was lost; to be charged",
    });
    expect(reconciled.reconciliation).toMatchObject({
      differenceCentavos: -50_000,
      varianceKind: "shortage",
      varianceReason: "Collector says ₱500 was lost; to be charged",
    });
    const audit = await auditFor("collection_batch.reconcile", batch.id);
    expect(audit[0]?.reason).toBe("Collector says ₱500 was lost; to be charged");
    expect(audit[0]?.newValues).toMatchObject({ differenceCentavos: -50_000, varianceKind: "shortage" });
  });

  it("cannot be reconciled as balanced", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_950_000 });
    await expect(reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "DIFFERENCE_CHANGED",
      status: 409,
      message: expect.stringContaining("₱500.00 shortage"),
    });
    expect((await getBatch(db, batch.id)).status).toBe("remitted");
    expect(await auditFor("collection_batch.reconcile", batch.id)).toHaveLength(0);
  });

  it("cannot be reconciled without a reason", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_950_000 });
    await expect(reconcileBatch(db, actorId, batch.id, { differenceCentavos: -50_000 })).rejects.toMatchObject({
      code: "VARIANCE_REASON_REQUIRED",
      status: 422,
    });
  });

  it("cannot be closed silently as balanced: the closer must confirm the shortage", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_950_000 });
    await reconcileBatch(db, actorId, batch.id, { differenceCentavos: -50_000, varianceReason: "Short ₱500" });

    await expect(closeBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "DIFFERENCE_CHANGED",
      message: expect.stringContaining("₱500.00 shortage"),
    });
    expect((await getBatch(db, batch.id)).status).toBe("reconciled");

    const closed = await closeBatch(db, actorId, batch.id, { differenceCentavos: -50_000 });
    expect(closed.status).toBe("closed");
    expect(closed.reconciliation?.varianceKind).toBe("shortage");
  });

  it("leaves the subscribers' balances alone: they paid the collector in full", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_950_000 });
    await reconcileBatch(db, actorId, batch.id, { differenceCentavos: -50_000, varianceReason: "Short ₱500" });
    // Invoices are inserted without their ledger debit here, so check the invoices themselves.
    const rows = await db.select({ status: invoices.status, paid: invoices.paidCentavos }).from(invoices);
    expect(rows).toEqual([
      { status: "paid", paid: 1_000_000 },
      { status: "paid", paid: 1_000_000 },
    ]);
  });
});

describe("reconcileBatch", () => {
  it("records an overage too", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_010_000 });
    const reconciled = await reconcileBatch(db, actorId, batch.id, {
      differenceCentavos: 10_000,
      varianceReason: "Change not returned to a subscriber",
    });
    expect(reconciled.reconciliation).toMatchObject({ differenceCentavos: 10_000, varianceKind: "overage" });
  });

  it("can reconcile a submitted batch with nothing remitted as a full shortage", async () => {
    const batch = await submittedWith20k();
    const reconciled = await reconcileBatch(db, actorId, batch.id, {
      differenceCentavos: -2_000_000,
      varianceReason: "Collector did not report back",
    });
    expect(reconciled.reconciliation).toMatchObject({ remittedCashCentavos: 0, differenceCentavos: -2_000_000 });
  });

  it("only counts cash: cheques are collected but not part of the expected cash", async () => {
    const { batch } = await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }));
    await dispatchBatch(db, actorId, batch.id);
    await collect(batch.id, alpha, 1_000_000);
    await collect(batch.id, bravo, 1_000_000, "cheque");
    await submitBatch(db, actorId, batch.id);
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 1_000_000 });
    const reconciled = await reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    expect(reconciled.reconciliation?.expectedCashCentavos).toBe(1_000_000);
  });

  it("uses only remittances that are not voided", async () => {
    const batch = await submittedWith20k();
    const wrong = await recordRemittance(db, actorId, batch.id, { amountCentavos: 200_000 });
    await voidRemittance(db, actorId, batch.id, wrong.remittances[0]!.id, { reason: "Extra zero missing" });
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_000_000 });
    const reconciled = await reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    expect(reconciled.reconciliation?.remittedCashCentavos).toBe(2_000_000);
  });

  it("refuses a batch that is still in progress", async () => {
    const { batch } = await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }));
    await dispatchBatch(db, actorId, batch.id);
    await expect(reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("refuses when the figures changed after the user looked (a collection reversed)", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_000_000 });
    const seen = await getBatch(db, batch.id);
    await reversePayment(db, actorId, seen.collections[0]!.paymentId, { reason: "Posted to the wrong subscriber" });
    await expect(reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "DIFFERENCE_CHANGED",
      message: expect.stringContaining("₱10,000.00 overage"),
    });
  });

  it("freezes its figures: no more remittances, and a later reversal is listed as an exception", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_000_000 });
    const reconciled = await reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    await expect(recordRemittance(db, actorId, batch.id, { amountCentavos: 100 })).rejects.toMatchObject({
      code: "BATCH_NOT_REMITTING",
    });

    await reversePayment(db, actorId, reconciled.collections[0]!.paymentId, { reason: "Cheque bounced" });
    const after = await getBatch(db, batch.id);
    expect(after.reconciliation?.expectedCashCentavos).toBe(2_000_000);
    expect(after.money.cashCollectedCentavos).toBe(1_000_000);
    expect(after.reversedAfterReconciliation.map((c) => [c.receiptNumber, c.reversalReason])).toEqual([
      [reconciled.collections[0]!.receiptNumber, "Cheque bounced"],
    ]);
    expect(reconciled.reversedAfterReconciliation).toEqual([]);
  });
});

describe("closeBatch", () => {
  it("needs a reconciled batch", async () => {
    const batch = await submittedWith20k();
    await expect(closeBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("is final", async () => {
    const batch = await submittedWith20k();
    await recordRemittance(db, actorId, batch.id, { amountCentavos: 2_000_000 });
    await reconcileBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    await closeBatch(db, actorId, batch.id, { differenceCentavos: 0 });
    await expect(closeBatch(db, actorId, batch.id, { differenceCentavos: 0 })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(await auditFor("collection_batch.close", batch.id)).toHaveLength(1);
  });
});
