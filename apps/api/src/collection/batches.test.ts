import { and, eq, sql } from "drizzle-orm";
import {
  areaCreateSchema,
  batchCreateSchema,
  collectorCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { auditLogs } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import {
  addBatchAccount,
  cancelBatch,
  createBatch,
  dispatchBatch,
  getBatch,
  listBatches,
  removeBatchAccount,
  submitBatch,
} from "./batches";
import { createArea, createCollector, updateCollector } from "./service";

const { db, pool } = createTestDb();

// Far past and far future due dates, so "arrears" and "current" do not depend on today's date.
const PAST_DUE = "2000-01-05";
const NOT_YET_DUE = "2999-12-05";

let actorId: string;
let areaA: string;
let areaB: string;
let col1: string;
let col2: string;
let inactiveCollector: string;
let planId: string;
let cycleId: string;
let invoiceNo = 0;
let receiptNo = 0;

/** Subscribers by role in these tests. */
const s = {} as Record<
  "arrears" | "current" | "paidUp" | "overrideIn" | "overrideOut" | "withCredit",
  { id: string; serviceId: string; accountNumber: string }
>;

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(values),
  );
  return result.rows[0]!.id;
}

async function makeSubscriber(
  fullName: string,
  opts: { collector: string; area: string; barangay: string; line1: string; serviceCollector?: string },
) {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay: 5,
      collectionAreaId: opts.area,
      assignedCollectorId: opts.collector,
      address: { line1: opts.line1, barangay: opts.barangay, city: "Malaybalay" },
    }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({
      planId,
      installationAddressId: subscriber.addresses[0]!.id,
      assignedCollectorId: opts.serviceCollector ?? null,
    }),
  );
  return { id: subscriber.id, serviceId: service.id, accountNumber: subscriber.accountNumber };
}

/** A finalized, unpaid invoice inserted directly (the billing service is tested elsewhere). */
async function openInvoice(who: { id: string; serviceId: string }, dueDate: string, total = 99_900) {
  invoiceNo += 1;
  const id = await insert("invoices", {
    billing_cycle_id: cycleId,
    subscriber_id: who.id,
    service_account_id: who.serviceId,
    // Billed for the due date's month (both test months have 31 days).
    period_start: `${dueDate.slice(0, 8)}01`,
    period_end: `${dueDate.slice(0, 8)}31`,
    invoice_date: `${dueDate.slice(0, 8)}01`,
    due_date: dueDate,
    total_centavos: total,
    created_by_user_id: actorId,
  });
  await pool.query(
    `UPDATE invoices SET status = 'unpaid', invoice_number = $2, finalized_at = now(), finalized_by_user_id = $3 WHERE id = $1`,
    [id, `INV-B${String(invoiceNo).padStart(5, "0")}`, actorId],
  );
}

function rawPayment(subscriberId: string, overrides: Record<string, unknown> = {}) {
  receiptNo += 1;
  return insert("payments", {
    receipt_number: `RCPT-B${String(receiptNo).padStart(5, "0")}`,
    subscriber_id: subscriberId,
    method: "cash",
    amount_centavos: 20_000,
    payment_date: "2026-09-01",
    received_by_user_id: actorId,
    ...overrides,
  });
}

const auditFor = (action: string, entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));

const newBatch = (collectorId: string, extra: Record<string, unknown> = {}) =>
  createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate: "2026-10-10", ...extra }));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "batch_actor", "Passw0rd!test", "collection_supervisor");

  areaA = (await createArea(db, actorId, areaCreateSchema.parse({ code: "ZONE-A", name: "Zone A" }))).id;
  areaB = (await createArea(db, actorId, areaCreateSchema.parse({ code: "ZONE-B", name: "Zone B" }))).id;
  col1 = (await createCollector(db, actorId, collectorCreateSchema.parse({ code: "COL-B1", fullName: "Collector One" }))).id;
  col2 = (await createCollector(db, actorId, collectorCreateSchema.parse({ code: "COL-B2", fullName: "Collector Two" }))).id;
  inactiveCollector = (
    await createCollector(db, actorId, collectorCreateSchema.parse({ code: "COL-B3", fullName: "Former Collector" }))
  ).id;
  await updateCollector(db, actorId, inactiveCollector, { isActive: false });
  planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-batch", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;

  s.arrears = await makeSubscriber("Alpha Arrears", { collector: col1, area: areaA, barangay: "Poblacion", line1: "Purok 1" });
  s.current = await makeSubscriber("Bravo Current", { collector: col1, area: areaB, barangay: "Casisang", line1: "Purok 9" });
  s.paidUp = await makeSubscriber("Charlie Paid Up", { collector: col1, area: areaA, barangay: "Poblacion", line1: "Purok 2" });
  // Subscriber belongs to collector 2, but the service is handled by collector 1.
  s.overrideIn = await makeSubscriber("Delta Override", {
    collector: col2,
    area: areaA,
    barangay: "Poblacion",
    line1: "Purok 3",
    serviceCollector: col1,
  });
  // Subscriber belongs to collector 1, but the service is handled by collector 2.
  s.overrideOut = await makeSubscriber("Echo Elsewhere", {
    collector: col1,
    area: areaA,
    barangay: "Poblacion",
    line1: "Purok 4",
    serviceCollector: col2,
  });
  s.withCredit = await makeSubscriber("Foxtrot Credit", { collector: col1, area: areaA, barangay: "Lumbo", line1: "Purok 2" });

  cycleId = await insert("billing_cycles", { period_start: "2026-09-01", period_end: "2026-09-30", created_by_user_id: actorId });
  await openInvoice(s.arrears, PAST_DUE);
  await openInvoice(s.arrears, NOT_YET_DUE, 50_000);
  await openInvoice(s.current, NOT_YET_DUE);
  await openInvoice(s.overrideIn, PAST_DUE);
  await openInvoice(s.overrideOut, PAST_DUE);
  await openInvoice(s.withCredit, NOT_YET_DUE);
});

beforeEach(async () => {
  // Also clears payments (they reference batches), so the credit is put back each time.
  await db.execute(sql`TRUNCATE collection_batches, batch_accounts, collector_remittances, payments CASCADE`);
  await rawPayment(s.withCredit.id); // ₱200.00 unapplied credit
});

afterAll(async () => {
  await pool.end();
});

describe("createBatch", () => {
  it("takes the collector's owing subscribers, by each service's effective collector", async () => {
    const { batch, skipped } = await newBatch(col1);
    expect(batch.batchNumber).toMatch(/^CB-\d{6}$/);
    expect(batch.status).toBe("open");
    expect(batch.collector.code).toBe("COL-B1");
    expect(skipped).toEqual([]);
    // Not paid-up Charlie, not Echo (service is collector 2's); Delta is in through the override.
    // Route order: area, barangay, street, name.
    expect(batch.accounts.map((a) => a.fullName)).toEqual(["Foxtrot Credit", "Alpha Arrears", "Delta Override", "Bravo Current"]);
  });

  it("snapshots current bill, arrears, credit and total due", async () => {
    const { batch } = await newBatch(col1);
    const by = (id: string) => batch.accounts.find((a) => a.subscriberId === id)!;
    expect(by(s.arrears.id)).toMatchObject({ currentCentavos: 50_000, arrearsCentavos: 99_900, creditCentavos: 0, totalDueCentavos: 149_900 });
    expect(by(s.withCredit.id)).toMatchObject({ currentCentavos: 99_900, arrearsCentavos: 0, creditCentavos: 20_000, totalDueCentavos: 79_900 });
    expect(by(s.current.id).addressLine).toBe("Purok 9");
    expect(batch.totals).toEqual({
      accountCount: 4,
      currentCentavos: 249_800,
      arrearsCentavos: 199_800,
      totalDueCentavos: 429_600,
    });
  });

  it("can be limited to one area", async () => {
    const { batch } = await newBatch(col1, { collectionAreaId: areaB });
    expect(batch.area?.code).toBe("ZONE-B");
    expect(batch.accounts.map((a) => a.fullName)).toEqual(["Bravo Current"]);
  });

  it("writes one audit row with what was built", async () => {
    const { batch } = await newBatch(col1);
    const audit = await auditFor("collection_batch.create", batch.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(actorId);
    expect(audit[0]?.newValues).toMatchObject({ collectorCode: "COL-B1", accountCount: 4, totalDueCentavos: 429_600 });
  });

  it("leaves out and reports subscribers already on another live batch", async () => {
    const first = await newBatch(col1, { collectionAreaId: areaB });
    const { batch, skipped } = await newBatch(col1);
    expect(batch.accounts.map((a) => a.fullName)).not.toContain("Bravo Current");
    expect(skipped).toEqual([
      expect.objectContaining({ accountNumber: s.current.accountNumber, batchNumber: first.batch.batchNumber }),
    ]);
  });

  it("frees subscribers again once the other batch is submitted or cancelled", async () => {
    const first = await newBatch(col1, { collectionAreaId: areaB });
    await cancelBatch(db, actorId, first.batch.id, { reason: "Typhoon" });
    const { batch, skipped } = await newBatch(col1);
    expect(skipped).toEqual([]);
    expect(batch.accounts.map((a) => a.fullName)).toContain("Bravo Current");
  });

  it("refuses an inactive or unknown collector, writing nothing", async () => {
    await expect(newBatch(inactiveCollector)).rejects.toMatchObject({ code: "COLLECTOR_INACTIVE", status: 409 });
    await expect(newBatch("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "COLLECTOR_NOT_FOUND" });
    expect((await listBatches(db, { page: 1, pageSize: 25 })).total).toBe(0);
  });
});

describe("batch accounts", () => {
  it("adds a subscriber by hand, even one owing nothing, and audits it", async () => {
    const { batch } = await newBatch(col1);
    const updated = await addBatchAccount(db, actorId, batch.id, { subscriberId: s.paidUp.id });
    const added = updated.accounts.find((a) => a.subscriberId === s.paidUp.id);
    expect(added).toMatchObject({ totalDueCentavos: 0, addedLate: false });
    const audit = await auditFor("collection_batch.add_account", batch.id);
    expect(audit[0]?.newValues).toMatchObject({ accountNumber: s.paidUp.accountNumber, totalDueCentavos: 0 });
  });

  it("blocks a subscriber who is already on this or another live batch", async () => {
    const first = await newBatch(col1, { collectionAreaId: areaB });
    const second = await newBatch(col2);
    await expect(addBatchAccount(db, actorId, first.batch.id, { subscriberId: s.current.id })).rejects.toMatchObject({
      code: "ALREADY_ON_BATCH",
    });
    await expect(addBatchAccount(db, actorId, second.batch.id, { subscriberId: s.current.id })).rejects.toMatchObject({
      code: "ON_ANOTHER_BATCH",
      message: expect.stringContaining(first.batch.batchNumber),
    });
    expect(await auditFor("collection_batch.add_account", second.batch.id)).toHaveLength(0);
  });

  it("marks accounts added after dispatch as late", async () => {
    const { batch } = await newBatch(col1, { collectionAreaId: areaB });
    await dispatchBatch(db, actorId, batch.id);
    const updated = await addBatchAccount(db, actorId, batch.id, { subscriberId: s.paidUp.id });
    expect(updated.accounts.find((a) => a.subscriberId === s.paidUp.id)?.addedLate).toBe(true);
    expect(updated.accounts.find((a) => a.subscriberId === s.current.id)?.addedLate).toBe(false);
  });

  it("removes an account only while the batch is open", async () => {
    const { batch } = await newBatch(col1);
    const updated = await removeBatchAccount(db, actorId, batch.id, s.arrears.id);
    expect(updated.accounts.map((a) => a.subscriberId)).not.toContain(s.arrears.id);
    expect(await auditFor("collection_batch.remove_account", batch.id)).toHaveLength(1);

    await expect(removeBatchAccount(db, actorId, batch.id, s.arrears.id)).rejects.toMatchObject({ code: "NOT_ON_BATCH" });
    await dispatchBatch(db, actorId, batch.id);
    await expect(removeBatchAccount(db, actorId, batch.id, s.current.id)).rejects.toMatchObject({
      code: "BATCH_NOT_EDITABLE",
      status: 409,
    });
  });

  it("adds nothing once the batch is submitted", async () => {
    const { batch } = await newBatch(col1);
    await dispatchBatch(db, actorId, batch.id);
    await submitBatch(db, actorId, batch.id);
    await expect(addBatchAccount(db, actorId, batch.id, { subscriberId: s.paidUp.id })).rejects.toMatchObject({
      code: "BATCH_NOT_EDITABLE",
    });
  });
});

describe("batch lifecycle", () => {
  it("dispatches and submits, recording who and when, with an audit row each", async () => {
    const { batch } = await newBatch(col1);
    const dispatched = await dispatchBatch(db, actorId, batch.id);
    expect(dispatched.status).toBe("in_progress");
    expect(dispatched.dispatched?.byName).toBeTruthy();
    const submitted = await submitBatch(db, actorId, batch.id);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submitted).not.toBeNull();

    expect(await auditFor("collection_batch.dispatch", batch.id)).toHaveLength(1);
    const audit = await auditFor("collection_batch.submit", batch.id);
    expect(audit[0]?.oldValues).toEqual({ status: "in_progress" });
    expect(audit[0]?.newValues).toEqual({ status: "submitted" });
  });

  it("will not dispatch an empty batch", async () => {
    // Collector 2 only has Echo (Zone A), so a Zone B batch for collector 2 is empty.
    const { batch } = await newBatch(col2, { collectionAreaId: areaB });
    expect(batch.accounts).toHaveLength(0);
    await expect(dispatchBatch(db, actorId, batch.id)).rejects.toMatchObject({ code: "BATCH_EMPTY", status: 409 });
  });

  it("refuses steps out of order without writing an audit row", async () => {
    const { batch } = await newBatch(col1);
    await expect(submitBatch(db, actorId, batch.id)).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    expect(await auditFor("collection_batch.submit", batch.id)).toHaveLength(0);
    expect((await getBatch(db, batch.id)).status).toBe("open");
  });

  it("cancels with a reason, which is audited", async () => {
    const { batch } = await newBatch(col1);
    const cancelled = await cancelBatch(db, actorId, batch.id, { reason: "Collector sick" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelled?.reason).toBe("Collector sick");
    const audit = await auditFor("collection_batch.cancel", batch.id);
    expect(audit[0]?.reason).toBe("Collector sick");
  });

  it("cannot cancel once a collection is recorded, or after submission", async () => {
    const { batch } = await newBatch(col1);
    await dispatchBatch(db, actorId, batch.id);
    await rawPayment(s.arrears.id, { collection_batch_id: batch.id, collector_id: col1 });
    await expect(cancelBatch(db, actorId, batch.id, { reason: "Oops" })).rejects.toMatchObject({ code: "HAS_COLLECTIONS" });

    await submitBatch(db, actorId, batch.id);
    await expect(cancelBatch(db, actorId, batch.id, { reason: "Oops" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("listBatches", () => {
  it("filters by status and collector, with account counts and totals", async () => {
    const a = await newBatch(col1, { collectionAreaId: areaA });
    const b = await newBatch(col1, { collectionAreaId: areaB });
    await dispatchBatch(db, actorId, b.batch.id);

    const open = await listBatches(db, { page: 1, pageSize: 25, status: "open" });
    expect(open.items.map((i) => i.batchNumber)).toEqual([a.batch.batchNumber]);
    expect(open.items[0]).toMatchObject({ accountCount: 3, totalDueCentavos: 329_700, areaCode: "ZONE-A" });

    const mine = await listBatches(db, { page: 1, pageSize: 25, collectorId: col1 });
    expect(mine.total).toBe(2);
    const others = await listBatches(db, { page: 1, pageSize: 25, collectorId: col2 });
    expect(others.total).toBe(0);
  });
});
