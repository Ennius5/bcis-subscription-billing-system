import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  adjustmentCreateSchema,
  areaCreateSchema,
  billingRunSchema,
  billingVsCollectionQuerySchema,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  revenueQuerySchema,
  serviceAccountCreateSchema,
  servicePlanChangeSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createAdjustment } from "../billing/adjustments";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { createArea } from "../collection/service";
import { dbToday } from "../db/query_helpers";
import { auditLogs, invoices } from "../db/schema";
import { postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServicePlan, changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { getBillingVsCollection, getRevenueReport } from "./billing";

// Through the real billing service: last month and this month are generated and finalized,
// then one invoice gets a credit adjustment (dated today) and one subscriber pays today.
//   S1 (area ZONE-RPT, Internet 999 + 500 installation): last month 1,499.00, this month 999.00
//   S2 (no area, Cable 400):                              last month   400.00, this month 400.00

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let thisMonth: string;
let lastMonth: string;

const bvc = (from: string, to: string) => getBillingVsCollection(db, billingVsCollectionQuerySchema.parse({ from, to }));
const revenue = (from: string, to: string, dimension: "plan" | "service_type" | "area") =>
  getRevenueReport(db, revenueQuerySchema.parse({ from, to, dimension }));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas CASCADE`);
  const actorId = await createTestUser(db, "rptb_admin", PASSWORD, "administrator");
  await createTestUser(db, "rptb_viewer", PASSWORD, "viewer");
  await createTestUser(db, "rptb_auditor", PASSWORD, "auditor");

  thisMonth = periodOf(await dbToday(db));
  lastMonth = addMonths(thisMonth, -1);

  const internet = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({
      code: "rpt-inet",
      name: "Internet 999",
      serviceType: "internet",
      priceCentavos: 99_900,
      installationFeeCentavos: 50_000,
    }),
  );
  const cable = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({ code: "rpt-cable", name: "Cable 400", serviceType: "cable", priceCentavos: 40_000 }),
  );
  const area = await createArea(db, actorId, areaCreateSchema.parse({ code: "zone-rpt", name: "Report Zone" }));

  const subscribe = async (fullName: string, planId: string, collectionAreaId?: string) => {
    const subscriber = await createSubscriber(
      db,
      actorId,
      subscriberCreateSchema.parse({
        fullName,
        billingDay: 5,
        collectionAreaId,
        address: { line1: "Purok 3", barangay: "Poblacion", city: "Malaybalay" },
      }),
    );
    const service = await createServiceAccount(
      db,
      actorId,
      subscriber.id,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
    );
    await changeServiceStatus(
      db,
      actorId,
      service.id,
      serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
    );
    return { subscriberId: subscriber.id, serviceId: service.id };
  };
  const s1 = await subscribe("Revenue One", internet.id, area.id);
  const s2 = await subscribe("Revenue Two", cable.id);

  for (const period of [lastMonth, thisMonth]) {
    await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period }));
    await finalizeBilling(db, actorId, billingRunSchema.parse({ period }));
  }

  // Moving S1 to cable afterwards must not move its past revenue.
  await changeServicePlan(db, actorId, s1.serviceId, servicePlanChangeSchema.parse({ planId: cable.id, reason: "Downgrade" }));

  const [s1LastMonth] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.serviceAccountId, s1.serviceId), eq(invoices.periodStart, periodBounds(lastMonth).start)));
  await createAdjustment(
    db,
    actorId,
    s1LastMonth!.id,
    adjustmentCreateSchema.parse({ kind: "credit", category: "service_outage", amountCentavos: 10_000, reason: "Two days down" }),
  );
  await postPayment(db, actorId, paymentCreateSchema.parse({ subscriberId: s2.subscriberId, method: "cash", amountCentavos: 40_000 }));

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("billing vs collection", () => {
  it("compares billed (by billing month) with collected (by payment date), adjustments in the month posted", async () => {
    const r = await bvc(lastMonth, thisMonth);
    expect(r.months.map((m) => m.month)).toEqual([lastMonth, thisMonth]);
    expect(r.months[0]).toMatchObject({
      invoiceCount: 2,
      billedCentavos: 189_900,
      adjustmentsCentavos: 0,
      netBilledCentavos: 189_900,
      collectedCentavos: 0,
      collectionRateBasisPoints: 0,
      gapCentavos: 189_900,
    });
    expect(r.months[1]).toMatchObject({
      invoiceCount: 2,
      billedCentavos: 139_900,
      adjustmentCount: 1,
      adjustmentsCentavos: -10_000,
      netBilledCentavos: 129_900,
      collectedCentavos: 40_000,
      collectionRateBasisPoints: 3079, // 400 / 1,299 = 30.79%
    });
    expect(r.totals).toMatchObject({
      billedCentavos: 329_800,
      adjustmentsCentavos: -10_000,
      netBilledCentavos: 319_800,
      collectedCentavos: 40_000,
      collectionRateBasisPoints: 1251,
      gapCentavos: 279_800,
    });
  });

  it("shows months with nothing billed as zero, rate unknown", async () => {
    const next = addMonths(thisMonth, 1);
    const r = await bvc(next, next);
    expect(r.months[0]).toMatchObject({ invoiceCount: 0, netBilledCentavos: 0, collectionRateBasisPoints: null });
  });
});

describe("revenue", () => {
  it("groups by the plan billed on the invoice, split by line type", async () => {
    const r = await revenue(lastMonth, thisMonth, "plan");
    expect(r.rows.map((row) => row.label)).toEqual(["RPT-INET Internet 999", "RPT-CABLE Cable 400"]);
    expect(r.rows[0]).toMatchObject({
      invoiceCount: 2,
      subscriptionCentavos: 199_800,
      installationCentavos: 50_000,
      reconnectionCentavos: 0,
      billedCentavos: 249_800,
      adjustmentsCentavos: -10_000,
      netCentavos: 239_800,
      shareBasisPoints: 7498,
    });
    expect(r.rows[1]).toMatchObject({ invoiceCount: 2, billedCentavos: 80_000, netCentavos: 80_000 });
    expect(r.totals).toMatchObject({ invoiceCount: 4, billedCentavos: 329_800, netCentavos: 319_800 });
  });

  it("groups by service type and by area (no area has its own row)", async () => {
    const byType = await revenue(lastMonth, thisMonth, "service_type");
    expect(byType.rows.map((r) => [r.label, r.netCentavos])).toEqual([
      ["Internet", 239_800],
      ["Cable", 80_000],
    ]);
    const byArea = await revenue(lastMonth, thisMonth, "area");
    expect(byArea.rows.map((r) => [r.key === "none" ? "none" : r.label, r.netCentavos])).toEqual([
      ["ZONE-RPT Report Zone", 239_800],
      ["none", 80_000],
    ]);
    expect(byArea.rows[1]!.label).toBe("No area");
  });

  it("puts an adjustment in the month it was posted, even for an older invoice", async () => {
    const last = await revenue(lastMonth, lastMonth, "plan");
    expect(last.totals).toMatchObject({ billedCentavos: 189_900, adjustmentsCentavos: 0 });
    const current = await revenue(thisMonth, thisMonth, "plan");
    expect(current.rows[0]).toMatchObject({ invoiceCount: 1, billedCentavos: 99_900, adjustmentsCentavos: -10_000, netCentavos: 89_900 });
  });
});

describe("billing report routes", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };

  it("serves both reports to report.view and exports to report.export, audited", async () => {
    const viewer = await bearer("rptb_viewer");
    const bvcUrl = `/reports/billing-vs-collection?from=${lastMonth}&to=${thisMonth}`;
    const revenueUrl = `/reports/revenue?from=${lastMonth}&to=${thisMonth}&dimension=area`;
    expect((await app.inject({ method: "GET", url: bvcUrl, headers: viewer })).json().totals.netBilledCentavos).toBe(319_800);
    expect((await app.inject({ method: "GET", url: revenueUrl, headers: viewer })).json().rows).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/reports/revenue/export?from=${lastMonth}&to=${thisMonth}&format=pdf`, headers: viewer })).statusCode).toBe(403);

    const auditor = await bearer("rptb_auditor");
    const pdf = await app.inject({ method: "GET", url: `/reports/billing-vs-collection/export?from=${lastMonth}&to=${thisMonth}&format=pdf`, headers: auditor });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-disposition"]).toBe(`attachment; filename="billing-vs-collection-${lastMonth}_to_${thisMonth}.pdf"`);
    const xlsx = await app.inject({
      method: "GET",
      url: `/reports/revenue/export?from=${lastMonth}&to=${thisMonth}&dimension=service_type&format=xlsx`,
      headers: auditor,
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-disposition"]).toBe(`attachment; filename="revenue-by-service-type-${lastMonth}_to_${thisMonth}.xlsx"`);

    const audits = await db.select({ entityId: auditLogs.entityId }).from(auditLogs).where(eq(auditLogs.action, "report.export"));
    expect(audits.map((a) => a.entityId)).toEqual(expect.arrayContaining(["billing-vs-collection", "revenue-by-service-type"]));
    expect(audits).toHaveLength(2);
  });

  it("validates month ranges", async () => {
    const viewer = await bearer("rptb_viewer");
    for (const url of [
      "/reports/billing-vs-collection?from=2026-12&to=2026-01",
      "/reports/billing-vs-collection?from=2026-1&to=2026-02",
      "/reports/revenue?from=2020-01&to=2026-01",
      "/reports/revenue?from=2026-01&to=2026-02&dimension=collector",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: viewer })).statusCode, url).toBe(400);
    }
  });
});
