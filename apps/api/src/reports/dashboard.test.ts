import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  agingQuerySchema,
  billingRunSchema,
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
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { dbToday } from "../db/query_helpers";
import { postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { getAgingReport } from "../receivables/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { getDashboard } from "./dashboard";

// One subscriber on 999.00, billed last month and this month, pays 500.00 today (oldest
// first, so last month's bill keeps 499.00 open and is long past its due date).

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let thisMonth: string;
let lastMonth: string;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  await pool.query(`UPDATE application_settings SET value = '7' WHERE key = 'grace_period_days'`);
  const actorId = await createTestUser(db, "dash_admin", PASSWORD, "administrator");
  await createTestUser(db, "dash_viewer", PASSWORD, "viewer");
  await createTestUser(db, "dash_cashier", PASSWORD, "cashier");
  await createTestUser(db, "dash_tech", PASSWORD, "technician");

  thisMonth = periodOf(await dbToday(db));
  lastMonth = addMonths(thisMonth, -1);
  const plan = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({ code: "dash-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({ fullName: "Dashboard Demo", billingDay: 5, address: { line1: "Purok 7", barangay: "Poblacion", city: "Valencia" } }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    actorId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
  );
  for (const period of [lastMonth, thisMonth]) {
    await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period }));
    await finalizeBilling(db, actorId, billingRunSchema.parse({ period }));
  }
  await postPayment(
    db,
    actorId,
    paymentCreateSchema.parse({ subscriberId: subscriber.id, method: "cash", amountCentavos: 50_000 }),
  );

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("dashboard", () => {
  it("gives this month's KPIs from the same services as the reports", async () => {
    const d = await getDashboard(db);
    expect(d.month).toBe(thisMonth);
    expect(d.kpis).toMatchObject({
      billedThisMonthCentavos: 99_900,
      collectedThisMonthCentavos: 50_000,
      collectionRateBasisPoints: 5005,
      receivableCentavos: 149_800,
      overdueSubscriberCount: 1,
      suspensionCandidateCount: 1,
    });
    const aging = await getAgingReport(db, agingQuerySchema.parse({}));
    expect(d.kpis.overdueCentavos).toBe(aging.overdueCentavos);
    expect(d.aging.reduce((t, b) => t + b.amountCentavos, 0)).toBe(149_800);
  });

  it("has six months of billing vs collection, every payment method, and the lists", async () => {
    const d = await getDashboard(db);
    expect(d.billingVsCollection.map((m) => m.month)).toEqual([-5, -4, -3, -2, -1, 0].map((n) => addMonths(thisMonth, n)));
    expect(d.billingVsCollection.at(-2)).toMatchObject({ month: lastMonth, netBilledCentavos: 99_900, collectedCentavos: 0 });
    expect(d.paymentMethods.map((m) => m.method)).toEqual(["cash", "gcash", "bank_transfer", "cheque", "other"]);
    expect(d.paymentMethods[0]).toEqual({ method: "cash", paymentCount: 1, netCentavos: 50_000 });
    expect(d.collectors).toEqual([]);
    expect(d.oldestOverdue).toEqual([
      expect.objectContaining({ subscriberName: "Dashboard Demo", oldestDueDate: `${lastMonth}-05`, planCode: "DASH-999" }),
    ]);
    expect(d.latestPayments).toEqual([expect.objectContaining({ amountCentavos: 50_000, method: "cash", status: "posted" })]);
    expect(d.latestPayments[0]).not.toHaveProperty("referenceNumber");
  });
});

describe("dashboard route", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };

  it("is for report.view (viewers included); cashiers and technicians are refused", async () => {
    expect((await app.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(401);
    const viewer = await app.inject({ method: "GET", url: "/dashboard", headers: await bearer("dash_viewer") });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().kpis.billedThisMonthCentavos).toBe(99_900);
    for (const username of ["dash_cashier", "dash_tech"]) {
      expect((await app.inject({ method: "GET", url: "/dashboard", headers: await bearer(username) })).statusCode, username).toBe(403);
    }
  });
});
