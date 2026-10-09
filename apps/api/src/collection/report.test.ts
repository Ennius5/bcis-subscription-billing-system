import { sql } from "drizzle-orm";
import {
  batchCreateSchema,
  collectorCreateSchema,
  fieldCollectionCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { cancelBatch, createBatch, dispatchBatch, submitBatch } from "./batches";
import { recordFieldCollection, recordRemittance } from "./field-collections";
import { closeBatch, reconcileBatch } from "./reconciliation";
import { getCollectorReport, type CollectorReport } from "./report";
import { createCollector, updateCollector } from "./service";

const { db, pool } = createTestDb();

let actorId: string;
let day: string; // the reported collection date
let earlier: string; // outside the reported range
const col = {} as Record<"one" | "two" | "idle" | "gone", string>;
let report: CollectorReport;

const rowFor = (collectorId: string) => report.collectors.find((c) => c.collectorId === collectorId);

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "report_actor", "Passw0rd!test", "collection_supervisor");
  const dates = await pool.query<{ day: string; earlier: string }>(
    `SELECT (CURRENT_DATE - 1)::text AS day, (CURRENT_DATE - 10)::text AS earlier`,
  );
  day = dates.rows[0]!.day;
  earlier = dates.rows[0]!.earlier;

  const collector = async (code: string, fullName: string) =>
    (await createCollector(db, actorId, collectorCreateSchema.parse({ code, fullName }))).id;
  col.one = await collector("COL-P1", "Collector One");
  col.two = await collector("COL-P2", "Collector Two");
  col.idle = await collector("COL-P3", "Idle Collector");
  col.gone = await collector("COL-P4", "Former Collector");
  await updateCollector(db, actorId, col.gone, { isActive: false });

  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-report", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2000-01-01', '2000-01-31', $1) RETURNING id`,
    [actorId],
  );
  let invoiceNo = 0;
  // A subscriber of the collector owing one past-due ₱10,000.00 invoice.
  const owing = async (fullName: string, collectorId: string) => {
    const s = await createSubscriber(
      db,
      actorId,
      subscriberCreateSchema.parse({
        fullName,
        billingDay: 5,
        assignedCollectorId: collectorId,
        address: { line1: "Purok 3", barangay: "Aglayan", city: "Malaybalay" },
      }),
    );
    const service = await createServiceAccount(
      db,
      actorId,
      s.id,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: s.addresses[0]!.id }),
    );
    invoiceNo += 1;
    await pool.query(
      `INSERT INTO invoices (billing_cycle_id, subscriber_id, service_account_id, period_start, period_end, invoice_date,
         due_date, total_centavos, created_by_user_id, status, invoice_number, finalized_at, finalized_by_user_id)
       VALUES ($1, $2, $3, '2000-01-01', '2000-01-31', '2000-01-01', '2000-01-05', 1000000, $4, 'unpaid', $5, now(), $4)`,
      [cycle.rows[0]!.id, s.id, service.id, actorId, `INV-P${String(invoiceNo).padStart(5, "0")}`],
    );
    return s.id;
  };
  const alpha = await owing("Alpha Report", col.one);
  const bravo = await owing("Bravo Report", col.one);
  const charlie = await owing("Charlie Report", col.two);

  const collect = (batchId: string, subscriberId: string, amountCentavos: number, method = "cash") =>
    recordFieldCollection(
      db,
      actorId,
      batchId,
      fieldCollectionCreateSchema.parse({
        subscriberId,
        method,
        amountCentavos,
        referenceNumber: method === "cheque" ? "CHQ-9" : null,
      }),
    );
  const build = async (collectorId: string, collectionDate: string) =>
    (await createBatch(db, actorId, batchCreateSchema.parse({ collectorId, collectionDate }))).batch.id;

  // Collector one: ₱10,000 cash + ₱5,000 cheque of ₱20,000 due; remits ₱9,500 (₱500 short); closed.
  const a = await build(col.one, day);
  await dispatchBatch(db, actorId, a);
  await collect(a, alpha, 1_000_000);
  await collect(a, bravo, 500_000, "cheque");
  await submitBatch(db, actorId, a);
  await recordRemittance(db, actorId, a, { amountCentavos: 950_000 });
  await reconcileBatch(db, actorId, a, { differenceCentavos: -50_000, varianceReason: "Short ₱500" });
  await closeBatch(db, actorId, a, { differenceCentavos: -50_000 });

  // Collector one again: a cancelled batch the same day, and an open one outside the range.
  const cancelled = await build(col.one, day);
  await cancelBatch(db, actorId, cancelled, { reason: "Rain" });
  await build(col.one, earlier);

  // Collector two: ₱10,000 cash of ₱10,000 due, plus a ₱1.00 entry that was reversed; not reconciled.
  const c = await build(col.two, day);
  await dispatchBatch(db, actorId, c);
  await collect(c, charlie, 1_000_000);
  const mistake = await collect(c, charlie, 100);
  await reversePayment(db, actorId, mistake.id, { reason: "Typed twice" });
  await submitBatch(db, actorId, c);

  report = await getCollectorReport(db, { from: day, to: day });
});

afterAll(async () => {
  await pool.end();
});

describe("getCollectorReport", () => {
  it("sums one collector's batches: collected, remitted, shortage and rate", () => {
    expect(rowFor(col.one)).toMatchObject({
      code: "COL-P1",
      batchCount: 1,
      unreconciledCount: 0,
      accountCount: 2,
      expectedTotalDueCentavos: 2_000_000,
      cashCollectedCentavos: 1_000_000,
      chequeCollectedCentavos: 500_000,
      remittedCentavos: 950_000,
      shortageCentavos: 50_000,
      overageCentavos: 0,
      collectionRateBasisPoints: 7_500,
    });
    expect(rowFor(col.one)?.batches).toEqual([
      expect.objectContaining({ status: "closed", differenceCentavos: -50_000, varianceKind: "shortage" }),
    ]);
  });

  it("leaves out cancelled batches and batches outside the date range", () => {
    expect(rowFor(col.one)?.batches).toHaveLength(1);
  });

  it("counts posted collections only, and flags batches not yet reconciled", () => {
    expect(rowFor(col.two)).toMatchObject({
      batchCount: 1,
      unreconciledCount: 1,
      cashCollectedCentavos: 1_000_000,
      remittedCentavos: 0,
      shortageCentavos: 0,
      collectionRateBasisPoints: 10_000,
    });
    expect(rowFor(col.two)?.batches[0]).toMatchObject({ status: "submitted", differenceCentavos: null, varianceKind: null });
  });

  it("lists an active collector with no batches, and drops an inactive one", () => {
    expect(rowFor(col.idle)).toMatchObject({ batchCount: 0, expectedTotalDueCentavos: 0, collectionRateBasisPoints: null });
    expect(rowFor(col.gone)).toBeUndefined();
    expect(report.collectors.map((c) => c.code)).toEqual(["COL-P1", "COL-P2", "COL-P3"]);
  });

  it("totals every collector", () => {
    expect(report.totals).toMatchObject({
      batchCount: 2,
      unreconciledCount: 1,
      expectedTotalDueCentavos: 3_000_000,
      cashCollectedCentavos: 2_000_000,
      chequeCollectedCentavos: 500_000,
      remittedCentavos: 950_000,
      shortageCentavos: 50_000,
      collectionRateBasisPoints: 8_333,
    });
  });

  it("shows the earlier batch when the range covers it", async () => {
    const wider = await getCollectorReport(db, { from: earlier, to: day });
    expect(wider.collectors.find((c) => c.collectorId === col.one)?.batchCount).toBe(2);
  });
});
