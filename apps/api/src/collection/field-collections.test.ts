import { and, eq, sql } from "drizzle-orm";
import {
  areaCreateSchema,
  batchCreateSchema,
  collectorCreateSchema,
  fieldCollectionCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, invoices, ledgerEntries, payments } from "../db/schema";
import { postPayment, reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { addBatchAccount, createBatch, dispatchBatch, getBatch, submitBatch } from "./batches";
import { recordFieldCollection, recordRemittance, voidRemittance } from "./field-collections";
import { createArea, createCollector } from "./service";

const { db, pool } = createTestDb();

let actorId: string;
let collectorId: string;
let areaId: string;
let planId: string;
let cycleId: string;
/** A few days ago, by the database clock: the batch's collection date. */
let collectionDate: string;
let today: string;
let invoiceNo = 0;

type Who = { id: string; serviceId: string; accountNumber: string };
let alpha: Who; // owes one past-due invoice
let bravo: Who; // owes one invoice not yet due
let outsider: Who; // not the collector's, not on the batch

async function makeSubscriber(fullName: string, collector: string | null): Promise<Who> {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay: 5,
      collectionAreaId: areaId,
      assignedCollectorId: collector,
      address: { line1: "Purok 5", barangay: "Sumpong", city: "Malaybalay" },
    }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  return { id: subscriber.id, serviceId: service.id, accountNumber: subscriber.accountNumber };
}

/** A finalized, unpaid ₱999.00 invoice inserted directly (billing is tested elsewhere). */
async function openInvoice(who: Who, dueDate: string): Promise<string> {
  invoiceNo += 1;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO invoices (billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, total_centavos, created_by_user_id, status, invoice_number, finalized_at, finalized_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $4, $6, 99900, $7, 'unpaid', $8, now(), $7) RETURNING id`,
    [
      cycleId,
      who.id,
      who.serviceId,
      `${dueDate.slice(0, 8)}01`,
      `${dueDate.slice(0, 8)}28`,
      dueDate,
      actorId,
      `INV-F${String(invoiceNo).padStart(5, "0")}`,
    ],
  );
  return result.rows[0]!.id;
}

/** A batch for the collector, in progress, with Alpha and Bravo on it. */
async function batchInProgress() {
  const { batch } = await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }));
  await dispatchBatch(db, actorId, batch.id);
  return batch;
}

const collect = (batchId: string, who: Who, amountCentavos: number, extra: Record<string, unknown> = {}) =>
  recordFieldCollection(
    db,
    actorId,
    batchId,
    fieldCollectionCreateSchema.parse({ subscriberId: who.id, method: "cash", amountCentavos, ...extra }),
  );

const auditFor = (action: string, entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));

let alphaInvoice: string;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "field_actor", "Passw0rd!test", "collection_supervisor");
  const dates = await pool.query<{ today: string; earlier: string }>(
    `SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 3)::text AS earlier`,
  );
  today = dates.rows[0]!.today;
  collectionDate = dates.rows[0]!.earlier;

  areaId = (await createArea(db, actorId, areaCreateSchema.parse({ code: "ZONE-F", name: "Zone F" }))).id;
  collectorId = (await createCollector(db, actorId, collectorCreateSchema.parse({ code: "COL-F1", fullName: "Field Collector" }))).id;
  planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-field", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  alpha = await makeSubscriber("Alpha Field", collectorId);
  bravo = await makeSubscriber("Bravo Field", collectorId);
  outsider = await makeSubscriber("Outsider Field", null);
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2026-09-01', '2026-09-30', $1) RETURNING id`,
    [actorId],
  );
  cycleId = cycle.rows[0]!.id;
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE collection_batches, batch_accounts, collector_remittances, payments, payment_allocations,
        payment_reversals, invoices, ledger_entries CASCADE`,
  );
  alphaInvoice = await openInvoice(alpha, "2000-01-05");
  await openInvoice(bravo, "2999-12-05");
});

afterAll(async () => {
  await pool.end();
});

describe("recordFieldCollection", () => {
  it("posts a real payment linked to the batch and collector, dated the collection date", async () => {
    const batch = await batchInProgress();
    const payment = await collect(batch.id, alpha, 99_900, { referenceNumber: "OR-1001" });

    expect(payment.receiptNumber).toMatch(/^RCPT-\d{6}$/);
    expect(payment.paymentDate).toBe(collectionDate);
    expect(payment.allocations.map((a) => a.amountCentavos)).toEqual([99_900]);

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(row).toMatchObject({ collectionBatchId: batch.id, collectorId, method: "cash" });
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, alphaInvoice));
    expect(invoice?.status).toBe("paid");
    const [ledger] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, payment.id));
    expect(ledger?.description).toBe(`Cash field collection, ${batch.batchNumber} (ref OR-1001)`);
    const audit = await auditFor("payment.post", payment.id);
    expect(audit[0]?.newValues).toMatchObject({ collectionBatchNumber: batch.batchNumber });
  });

  it("shows on the batch: per account, in the list and in the cash total", async () => {
    const batch = await batchInProgress();
    await collect(batch.id, alpha, 99_900);
    await collect(batch.id, bravo, 50_000, { method: "cheque", referenceNumber: "CHQ-77" });

    const detail = await getBatch(db, batch.id);
    expect(detail.collections.map((c) => [c.accountNumber, c.method, c.amountCentavos])).toEqual([
      [alpha.accountNumber, "cash", 99_900],
      [bravo.accountNumber, "cheque", 50_000],
    ]);
    expect(detail.accounts.find((a) => a.subscriberId === alpha.id)?.collectedCentavos).toBe(99_900);
    expect(detail.money).toEqual({
      expectedTotalDueCentavos: 199_800,
      cashCollectedCentavos: 99_900,
      chequeCollectedCentavos: 50_000,
      paidElsewhereCentavos: 0,
      nonCashCentavos: 50_000,
      uncollectedCentavos: 49_900,
      remittedCentavos: 0,
      collectionCount: 2,
    });
  });

  it("keeps an overpayment as the subscriber's credit", async () => {
    const batch = await batchInProgress();
    const payment = await collect(batch.id, alpha, 150_000);
    expect(payment.creditCentavos).toBe(50_100);
  });

  it("accepts another date, but not a future one", async () => {
    const batch = await batchInProgress();
    const payment = await collect(batch.id, alpha, 10_000, { paymentDate: today });
    expect(payment.paymentDate).toBe(today);
    await expect(collect(batch.id, alpha, 10_000, { paymentDate: "2999-01-01" })).rejects.toMatchObject({
      code: "PAYMENT_DATE_IN_FUTURE",
    });
  });

  it("refuses a subscriber who is not on the batch, or a batch that is not in progress, posting nothing", async () => {
    const { batch } = await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }));
    await expect(collect(batch.id, alpha, 10_000)).rejects.toMatchObject({ code: "BATCH_NOT_COLLECTING", status: 409 });
    await dispatchBatch(db, actorId, batch.id);
    await expect(collect(batch.id, outsider, 10_000)).rejects.toMatchObject({ code: "NOT_ON_BATCH" });
    await submitBatch(db, actorId, batch.id);
    await expect(collect(batch.id, alpha, 10_000)).rejects.toMatchObject({ code: "BATCH_NOT_COLLECTING" });

    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("accepts a late-added subscriber", async () => {
    const batch = await batchInProgress();
    await addBatchAccount(db, actorId, batch.id, { subscriberId: outsider.id });
    const payment = await collect(batch.id, outsider, 10_000);
    expect(payment.creditCentavos).toBe(10_000); // owes nothing, so it is all credit
  });

  it("stops counting a collection once it is reversed, but still lists it", async () => {
    const batch = await batchInProgress();
    const payment = await collect(batch.id, alpha, 99_900);
    await reversePayment(db, actorId, payment.id, { reason: "Entered on the wrong account" });

    const detail = await getBatch(db, batch.id);
    expect(detail.collections.map((c) => c.status)).toEqual(["reversed"]);
    expect(detail.money.cashCollectedCentavos).toBe(0);
    expect(detail.money.collectionCount).toBe(0);
  });

  it("counts what subscribers paid elsewhere while the collector was out as non-cash", async () => {
    const batch = await batchInProgress();
    await postPayment(db, actorId, { subscriberId: bravo.id, method: "bank_transfer", amountCentavos: 99_900, referenceNumber: "BANK-9" });
    await postPayment(db, actorId, { subscriberId: outsider.id, method: "cash", amountCentavos: 5_000 }); // not on the batch

    const detail = await getBatch(db, batch.id);
    expect(detail.accounts.find((a) => a.subscriberId === bravo.id)?.paidElsewhereCentavos).toBe(99_900);
    expect(detail.money).toMatchObject({ paidElsewhereCentavos: 99_900, nonCashCentavos: 99_900, uncollectedCentavos: 99_900 });

    await submitBatch(db, actorId, batch.id);
    // Paid after submission: no longer the batch's business.
    await postPayment(db, actorId, { subscriberId: alpha.id, method: "cash", amountCentavos: 99_900 });
    expect((await getBatch(db, batch.id)).money.paidElsewhereCentavos).toBe(99_900);
  });
});

describe("remittances", () => {
  async function submittedBatch() {
    const batch = await batchInProgress();
    await collect(batch.id, alpha, 99_900);
    await submitBatch(db, actorId, batch.id);
    return batch;
  }

  it("cannot be recorded before the batch is submitted", async () => {
    const batch = await batchInProgress();
    await expect(recordRemittance(db, actorId, batch.id, { amountCentavos: 1_000 })).rejects.toMatchObject({
      code: "BATCH_NOT_REMITTING",
      status: 409,
    });
  });

  it("moves the batch to remitted on the first entry and adds up later ones", async () => {
    const batch = await submittedBatch();
    const first = await recordRemittance(db, actorId, batch.id, { amountCentavos: 50_000, notes: "First envelope" });
    expect(first.status).toBe("remitted");
    const second = await recordRemittance(db, actorId, batch.id, { amountCentavos: 49_900 });
    expect(second.status).toBe("remitted");
    expect(second.remittances.map((r) => r.amountCentavos)).toEqual([50_000, 49_900]);
    expect(second.money.remittedCentavos).toBe(99_900);

    const audit = await auditFor("collection_batch.remit", batch.id);
    expect(audit).toHaveLength(2);
    expect(audit.find((a) => a.oldValues)?.newValues).toMatchObject({ status: "remitted", amountCentavos: 50_000 });
  });

  it("voids a wrong entry with a reason: still listed, no longer counted", async () => {
    const batch = await submittedBatch();
    const withEntry = await recordRemittance(db, actorId, batch.id, { amountCentavos: 9_990 });
    const remittanceId = withEntry.remittances[0]!.id;

    const voided = await voidRemittance(db, actorId, batch.id, remittanceId, { reason: "Typed ₱99.90 instead of ₱999.00" });
    expect(voided.remittances[0]?.voided?.reason).toBe("Typed ₱99.90 instead of ₱999.00");
    expect(voided.money.remittedCentavos).toBe(0);
    expect(voided.status).toBe("remitted");

    const audit = await auditFor("collection_batch.void_remittance", batch.id);
    expect(audit[0]?.reason).toBe("Typed ₱99.90 instead of ₱999.00");

    await expect(voidRemittance(db, actorId, batch.id, remittanceId, { reason: "Again" })).rejects.toMatchObject({
      code: "REMITTANCE_VOIDED",
    });
    expect(await auditFor("collection_batch.void_remittance", batch.id)).toHaveLength(1);
  });

  it("only voids entries of this batch", async () => {
    const batch = await submittedBatch();
    await expect(
      voidRemittance(db, actorId, batch.id, "00000000-0000-4000-8000-000000000000", { reason: "Wrong" }),
    ).rejects.toMatchObject({ code: "REMITTANCE_NOT_FOUND", status: 404 });
  });
});
