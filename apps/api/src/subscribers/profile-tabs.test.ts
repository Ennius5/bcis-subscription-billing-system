import { sql } from "drizzle-orm";
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
  subscriberUpdateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createAdjustment } from "../billing/adjustments";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { createBatch, dispatchBatch } from "../collection/batches";
import { recordFieldCollection } from "../collection/field-collections";
import { createArea, createCollector } from "../collection/service";
import { dbToday } from "../db/query_helpers";
import { invoices } from "../db/schema";
import { postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { createSubscriber, updateSubscriber } from "./service";

// Profile tabs (spec 4.3): the Audit tab gathers everything about one subscriber, the
// Collection tab lists the batches they were on. Two subscribers, so nothing of B leaks into A.

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let alphaId: string;
let bravoId: string;
let batchNumber: string;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  return res.json().token as string;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas CASCADE`);
  const adminId = await createTestUser(db, "tabs_admin", PASSWORD, "administrator");
  const supervisorId = await createTestUser(db, "tabs_supervisor", PASSWORD, "collection_supervisor");
  await createTestUser(db, "tabs_cashier", PASSWORD, "cashier");

  const today = await dbToday(db);
  const month = addMonths(periodOf(today), -1);
  const area = await createArea(db, adminId, areaCreateSchema.parse({ code: "TABS", name: "Zone Tabs" }));
  const collector = await createCollector(db, adminId, collectorCreateSchema.parse({ code: "COL-TABS", fullName: "Tab Collector" }));
  const plan = await createPlan(
    db,
    adminId,
    planCreateSchema.parse({ code: "tabs-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );

  const make = async (fullName: string) => {
    const subscriber = await createSubscriber(
      db,
      adminId,
      subscriberCreateSchema.parse({
        fullName,
        billingDay: 5,
        collectionAreaId: area.id,
        assignedCollectorId: collector.id,
        address: { line1: "Purok 1", barangay: "Poblacion", city: "Malaybalay" },
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
      serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(month).start }),
    );
    return subscriber.id;
  };
  alphaId = await make("Alpha Tabs");
  bravoId = await make("Bravo Tabs");

  await generateBillingDrafts(db, adminId, billingRunSchema.parse({ period: month }));
  await finalizeBilling(db, adminId, billingRunSchema.parse({ period: month }));

  // Alpha: a name change, an office payment, an adjustment and a field collection.
  await updateSubscriber(db, adminId, alphaId, subscriberUpdateSchema.parse({ fullName: "Alpha Tabs Renamed" }));
  await postPayment(db, adminId, paymentCreateSchema.parse({ subscriberId: alphaId, method: "cash", amountCentavos: 20_000 }));
  const [alphaInvoice] = await db.select({ id: invoices.id }).from(invoices).where(sql`${invoices.subscriberId} = ${alphaId}`);
  await createAdjustment(
    db,
    adminId,
    alphaInvoice!.id,
    adjustmentCreateSchema.parse({ kind: "credit", category: "service_outage", amountCentavos: 5_000, reason: "Outage" }),
  );
  const { batch } = await createBatch(db, supervisorId, batchCreateSchema.parse({ collectorId: collector.id, collectionDate: today }));
  batchNumber = batch.batchNumber;
  await dispatchBatch(db, supervisorId, batch.id);
  await recordFieldCollection(
    db,
    supervisorId,
    batch.id,
    fieldCollectionCreateSchema.parse({ subscriberId: alphaId, method: "cash", amountCentavos: 30_000 }),
  );

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("GET /subscribers/:id/audit", () => {
  it("gathers the subscriber's own rows and those of its services, invoices and payments", async () => {
    const headers = bearer(await tokenFor("tabs_admin"));
    const res = await app.inject({ method: "GET", url: `/subscribers/${alphaId}/audit?pageSize=100`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { id: string; action: string; entityType: string }[]; total: number }>();
    const types = new Set(body.items.map((r) => r.entityType));
    expect([...types].toSorted()).toEqual(["invoice", "payment", "service_account", "subscriber"]);
    const actions = body.items.map((r) => r.action);
    expect(actions).toContain("subscriber.update");
    expect(actions).toContain("invoice.adjust");
    expect(body.total).toBe(body.items.length);

    // Nothing about Bravo.
    const bravo = await app.inject({ method: "GET", url: `/subscribers/${bravoId}/audit?pageSize=100`, headers });
    const bravoIds = new Set(bravo.json<{ items: { id: string }[] }>().items.map((r) => r.id));
    expect(body.items.filter((r) => bravoIds.has(r.id))).toEqual([]);
  });

  it("pages newest first", async () => {
    const headers = bearer(await tokenFor("tabs_admin"));
    const page = await app.inject({ method: "GET", url: `/subscribers/${alphaId}/audit?pageSize=2&page=1`, headers });
    const body = page.json<{ items: { occurredAt: string }[]; total: number; pageSize: number }>();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBeGreaterThan(2);
    expect(body.items[0]!.occurredAt >= body.items[1]!.occurredAt).toBe(true);
  });

  it("needs audit.view as well as subscriber.view", async () => {
    const res = await app.inject({ method: "GET", url: `/subscribers/${alphaId}/audit`, headers: bearer(await tokenFor("tabs_cashier")) });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /subscribers/:id/collections", () => {
  it("lists the batches the subscriber was on, with the route-sheet amounts and what was collected", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subscribers/${alphaId}/collections`,
      headers: bearer(await tokenFor("tabs_supervisor")),
    });
    expect(res.statusCode).toBe(200);
    const [row] = res.json<{ batchNumber: string; collectedCentavos: number; totalDueCentavos: number; collections: { receiptNumber: string }[] }[]>();
    expect(row?.batchNumber).toBe(batchNumber);
    expect(row?.collectedCentavos).toBe(30_000);
    // 999.00 billed - 200.00 paid - 50.00 credit adjustment, frozen when the batch was made.
    expect(row?.totalDueCentavos).toBe(74_900);
    expect(row?.collections[0]?.receiptNumber).toMatch(/^RCPT-\d{6}$/);
  });

  it("needs collection.view as well as subscriber.view", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subscribers/${alphaId}/collections`,
      headers: bearer(await tokenFor("tabs_cashier")),
    });
    expect(res.statusCode).toBe(403);
  });
});
