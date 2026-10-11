import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  adjustmentCreateSchema,
  areaCreateSchema,
  batchCreateSchema,
  billingRunSchema,
  collectorCreateSchema,
  fieldCollectionCreateSchema,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { runIntegrityChecks } from "../backup/integrity";
import { createAdjustment } from "../billing/adjustments";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { createBatch, dispatchBatch, getBatch } from "../collection/batches";
import { recordFieldCollection } from "../collection/field-collections";
import { createArea, createCollector } from "../collection/service";
import { dbToday } from "../db/query_helpers";
import { adjustments, invoices, payments } from "../db/schema";
import { postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

/*
 * AT-09 (spec 7): two or three PCs post and read different valid operations at the same
 * time. Expected: no data corruption, no duplicate numbering, no cross-session effect.
 *
 * Every operation below is started at once with Promise.all, so they run on separate pool
 * connections in parallel, just as requests from three PCs reach the one API server. The
 * integrity check is the final judge: every invoice, allocation and ledger total must still
 * reconcile afterwards.
 */

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
let app: FastifyInstance;

// Three "PCs": the users who post at the same time.
let ownerId: string;
let adminId: string;
let cashierId: string;
let supervisorId: string;
let collectorId: string;
let subscriberIds: string[] = [];
let monthB: string;

const SUBSCRIBERS = 6;

/** Numbers like RCPT-000012 issued without repeats or gaps. */
function expectGapless(numbers: string[], prefix: string) {
  const values = numbers.map((n) => Number(n.slice(prefix.length))).toSorted((a, b) => a - b);
  expect(new Set(values).size, `duplicate ${prefix} numbers`).toBe(values.length);
  const first = values[0] ?? 0;
  expect(values, `gap in ${prefix} numbers`).toEqual(values.map((_, i) => first + i));
}

const bill = async (actorId: string, period: string) => {
  await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period }));
  return finalizeBilling(db, actorId, billingRunSchema.parse({ period }));
};

const pay = (actorId: string, subscriberId: string, amountCentavos: number) =>
  postPayment(db, actorId, paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos }));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(
    sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas, backup_history, integrity_checks CASCADE`,
  );
  // Fresh counters, so "gapless" can be checked from 1.
  await db.execute(sql`UPDATE document_sequences SET next_value = 1 WHERE name IN ('invoice', 'receipt', 'adjustment', 'collection_batch')`);

  ownerId = await createTestUser(db, "at09_owner", PASSWORD, "owner");
  adminId = await createTestUser(db, "at09_admin", PASSWORD, "administrator");
  cashierId = await createTestUser(db, "at09_cashier", PASSWORD, "cashier");
  supervisorId = await createTestUser(db, "at09_supervisor", PASSWORD, "collection_supervisor");

  const today = await dbToday(db);
  monthB = addMonths(periodOf(today), -1);
  const monthA = addMonths(monthB, -1);

  const area = await createArea(db, adminId, areaCreateSchema.parse({ code: "AT09", name: "Zone AT-09" }));
  collectorId = (await createCollector(db, adminId, collectorCreateSchema.parse({ code: "COL-AT09", fullName: "Demo Collector" }))).id;
  const plan = await createPlan(
    db,
    adminId,
    planCreateSchema.parse({ code: "at09-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );

  subscriberIds = [];
  for (let i = 1; i <= SUBSCRIBERS; i++) {
    const subscriber = await createSubscriber(
      db,
      adminId,
      subscriberCreateSchema.parse({
        fullName: `Concurrency Demo ${i}`,
        billingDay: 5,
        collectionAreaId: area.id,
        assignedCollectorId: collectorId,
        address: { line1: `Purok ${i}`, barangay: "Poblacion", city: "Malaybalay" },
      }),
    );
    const service = await createServiceAccount(
      db,
      adminId,
      subscriber.id,
      serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
    );
    await changeServiceStatus(
      db,
      adminId,
      service.id,
      serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(monthA).start }),
    );
    subscriberIds.push(subscriber.id);
  }
  await bill(adminId, monthA);

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("AT-09: concurrent users", () => {
  it("two PCs running the same billing month at once create one invoice per service, numbered without gaps", async () => {
    const runs = await Promise.allSettled([bill(adminId, monthB), bill(ownerId, monthB)]);
    // One run may find nothing left to do; neither may fail with a database error.
    const databaseErrors = runs
      .filter((run) => run.status === "rejected")
      .map((run) => String(run.reason))
      .filter((reason) => /deadlock|duplicate key|could not serialize/i.test(reason));
    expect(databaseErrors).toEqual([]);

    const monthBInvoices = await db
      .select({ serviceAccountId: invoices.serviceAccountId, number: invoices.invoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.periodStart, periodBounds(monthB).start), sql`${invoices.status} <> 'draft'`));
    expect(monthBInvoices).toHaveLength(SUBSCRIBERS);
    expect(new Set(monthBInvoices.map((i) => i.serviceAccountId)).size).toBe(SUBSCRIBERS);

    const all = await db.select({ number: invoices.invoiceNumber }).from(invoices).where(sql`${invoices.invoiceNumber} IS NOT NULL`);
    expectGapless(all.map((i) => i.number!), "INV-");
  });

  it("three PCs posting 30 payments at once get unique, gapless receipts and correct balances", async () => {
    const actors = [cashierId, adminId, ownerId];
    // Every subscriber gets five ₱100 payments, from different PCs, all at the same moment.
    const posted = await Promise.all(
      Array.from({ length: 30 }, (_, k) => pay(actors[k % 3]!, subscriberIds[k % SUBSCRIBERS]!, 10_000)),
    );

    expectGapless(posted.map((p) => p.receiptNumber), "RCPT-");
    // Each receipt names the user who actually posted it: no cross-session mix-up.
    const names = { [cashierId]: "Test cashier", [adminId]: "Test administrator", [ownerId]: "Test owner" };
    posted.forEach((p, k) => expect(p.receivedByName).toBe(names[actors[k % 3]!]));

    // Oldest first, never over-applied: 5 × ₱100 against month A's ₱999 on every subscriber.
    const rows = await db
      .select({ paid: invoices.paidCentavos, total: invoices.totalCentavos, period: invoices.periodStart })
      .from(invoices)
      .where(sql`${invoices.status} <> 'draft'`);
    for (const row of rows) expect(row.paid).toBeLessThanOrEqual(row.total);
    expect(rows.filter((r) => r.paid === 50_000)).toHaveLength(SUBSCRIBERS);
  });

  it("a collector's field collections and office payments for the same subscribers run side by side", async () => {
    const collectionDate = await dbToday(db);
    const { batch } = await createBatch(db, supervisorId, batchCreateSchema.parse({ collectorId, collectionDate }));
    await dispatchBatch(db, supervisorId, batch.id);

    const field = subscriberIds.map((subscriberId) =>
      recordFieldCollection(
        db,
        supervisorId,
        batch.id,
        fieldCollectionCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: 20_000 }),
      ),
    );
    const office = subscriberIds.map((subscriberId) => pay(cashierId, subscriberId, 5_000));
    const results = await Promise.all([...field, ...office]);

    const all = await db.select({ number: payments.receiptNumber }).from(payments);
    expectGapless(all.map((p) => p.number), "RCPT-");
    expect(results).toHaveLength(SUBSCRIBERS * 2);

    const detail = await getBatch(db, batch.id);
    expect(detail.money.cashCollectedCentavos).toBe(SUBSCRIBERS * 20_000);
  });

  it("adjustments and payments on the same invoice at once keep the invoice consistent", async () => {
    const [target] = await db
      .select({ id: invoices.id, subscriberId: invoices.subscriberId })
      .from(invoices)
      .where(and(eq(invoices.subscriberId, subscriberIds[0]!), eq(invoices.periodStart, periodBounds(monthB).start)));
    const credit = adjustmentCreateSchema.parse({
      kind: "credit",
      category: "service_outage",
      amountCentavos: 1_000,
      reason: "Outage credit",
    });

    await Promise.all([
      ...Array.from({ length: 5 }, (_, k) => createAdjustment(db, k % 2 ? adminId : ownerId, target!.id, credit)),
      ...Array.from({ length: 5 }, () => pay(cashierId, target!.subscriberId, 2_000)),
    ]);

    const numbers = await db.select({ number: adjustments.adjustmentNumber }).from(adjustments);
    expectGapless(numbers.map((a) => a.number), "ADJ-");
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, target!.id));
    expect(invoice!.adjustedCentavos).toBe(-5_000);
    expect(invoice!.paidCentavos).toBeLessThanOrEqual(invoice!.totalCentavos + invoice!.adjustedCentavos);
  });

  it("three signed-in users at once keep their own sessions and permissions", async () => {
    const login = async (username: string) =>
      (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } })).json().token as string;
    const [cashier, admin, supervisor] = await Promise.all([login("at09_cashier"), login("at09_admin"), login("at09_supervisor")]);
    const as = (token: string) => ({ authorization: `Bearer ${token}` });

    const [posted, me, batches, forbidden, whoAmI] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/payments",
        headers: as(cashier),
        payload: { subscriberId: subscriberIds[1], method: "cash", amountCentavos: 1_000 },
      }),
      app.inject({ method: "GET", url: "/auth/me", headers: as(admin) }),
      app.inject({ method: "GET", url: "/collection-batches", headers: as(supervisor) }),
      // The cashier never borrows the admin's rights, even mid-flight.
      app.inject({ method: "POST", url: "/billing/generate", headers: as(cashier), payload: { period: monthB } }),
      app.inject({ method: "GET", url: "/auth/me", headers: as(supervisor) }),
    ]);
    expect(posted.statusCode).toBe(200);
    expect(posted.json().receivedByName).toBe("Test cashier");
    expect(me.json().user.username).toBe("at09_admin");
    expect(batches.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    expect(whoAmI.json().user.username).toBe("at09_supervisor");

    // One PC signing out does not sign out the others.
    await app.inject({ method: "POST", url: "/auth/logout", headers: as(admin) });
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: as(admin) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: as(cashier) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: as(supervisor) })).statusCode).toBe(200);
  });

  it("afterwards, every invoice, allocation, ledger total and counter still reconciles", async () => {
    const report = await runIntegrityChecks(pool, { proofDir: path.join(os.tmpdir(), "bcis-at09-no-proofs") });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });
});
