import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addDays,
  addMonths,
  adjustmentCreateSchema,
  areaCreateSchema,
  billingRunSchema,
  exceptionsQuerySchema,
  masterListQuerySchema,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
  subscriberStatusChangeSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createAdjustment } from "../billing/adjustments";
import { finalizeBilling, generateBillingDrafts, voidInvoice } from "../billing/service";
import { createArea } from "../collection/service";
import { dbToday } from "../db/query_helpers";
import { auditLogs, invoices } from "../db/schema";
import { postPayment, reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { changeSubscriberStatus, createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { getExceptionsRegister, getMasterList } from "./registers";

// S1 (area ZONE-REG, Internet 999): last month's invoice gets a 100.00 credit and a 50.00
// penalty today, a 300.00 payment is posted and reversed today, and this month's invoice is
// voided today. S2 is inactive with nothing billed. S3 is archived.

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let today: string;
let areaId: string;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas CASCADE`);
  const actorId = await createTestUser(db, "reg_admin", PASSWORD, "administrator");
  await createTestUser(db, "reg_viewer", PASSWORD, "viewer");
  await createTestUser(db, "reg_auditor", PASSWORD, "auditor");

  today = await dbToday(db);
  const thisMonth = periodOf(today);
  const lastMonth = addMonths(thisMonth, -1);

  const plan = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({ code: "reg-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );
  areaId = (await createArea(db, actorId, areaCreateSchema.parse({ code: "zone-reg", name: "Register Zone" }))).id;

  const make = (fullName: string, extra: Record<string, unknown> = {}) =>
    createSubscriber(
      db,
      actorId,
      subscriberCreateSchema.parse({
        fullName,
        billingDay: 5,
        address: { line1: "Purok 5", barangay: "Poblacion", city: "Manolo Fortich" },
        ...extra,
      }),
    );
  const s1 = await make("Register One", {
    collectionAreaId: areaId,
    contacts: [{ type: "mobile", value: "0917 000 0001", isPrimary: true }],
  });
  const s2 = await make("Register Two");
  const s3 = await make("Register Three");
  await changeSubscriberStatus(db, actorId, s2.id, subscriberStatusChangeSchema.parse({ status: "inactive", reason: "Moved away" }));
  await changeSubscriberStatus(db, actorId, s3.id, subscriberStatusChangeSchema.parse({ status: "terminated", reason: "Closed" }));
  await changeSubscriberStatus(db, actorId, s3.id, subscriberStatusChangeSchema.parse({ status: "archived", reason: "Old account" }));

  const service = await createServiceAccount(
    db,
    actorId,
    s1.id,
    serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: s1.addresses[0]!.id }),
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
  const invoiceOf = async (period: string) =>
    (
      await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.serviceAccountId, service.id), eq(invoices.periodStart, periodBounds(period).start)))
    )[0]!.id;
  const lastInvoice = await invoiceOf(lastMonth);
  await createAdjustment(
    db,
    actorId,
    lastInvoice,
    adjustmentCreateSchema.parse({ kind: "credit", category: "service_outage", amountCentavos: 10_000, reason: "Outage" }),
  );
  await createAdjustment(
    db,
    actorId,
    lastInvoice,
    adjustmentCreateSchema.parse({ kind: "debit", category: "penalty", amountCentavos: 5_000, reason: "Late payment" }),
  );
  await voidInvoice(db, actorId, await invoiceOf(thisMonth), { reason: "Billed in error" });
  const payment = await postPayment(
    db,
    actorId,
    paymentCreateSchema.parse({ subscriberId: s1.id, method: "cash", amountCentavos: 30_000 }),
  );
  await reversePayment(db, actorId, payment.id, { reason: "Wrong subscriber" });

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("subscriber master list", () => {
  it("lists everyone but archived by default, with rate, plans, contact and balance", async () => {
    const list = await getMasterList(db, masterListQuerySchema.parse({}));
    expect(list.rows.map((r) => r.fullName)).toEqual(["Register One", "Register Two"]);
    expect(list.rows[0]).toMatchObject({
      status: "active",
      area: "ZONE-REG Register Zone",
      address: "Purok 5, Poblacion, Manolo Fortich",
      contact: "0917 000 0001",
      activeServiceCount: 1,
      plans: "REG-999",
      monthlyRateCentavos: 99_900,
      // 999 - 100 + 50 + 999 (voided) - 999 + 300 - 300
      balanceCentavos: 94_900,
    });
    expect(list.statusCounts).toEqual({ active: 1, inactive: 1, terminated: 0, archived: 0 });
    expect(list.totals).toEqual({ subscriberCount: 2, activeServiceCount: 1, monthlyRateCentavos: 99_900, balanceCentavos: 94_900 });
  });

  it("filters by status (archived only when asked) and by area", async () => {
    const archived = await getMasterList(db, masterListQuerySchema.parse({ status: "archived" }));
    expect(archived.rows.map((r) => r.fullName)).toEqual(["Register Three"]);
    const inArea = await getMasterList(db, masterListQuerySchema.parse({ areaId }));
    expect(inArea.rows.map((r) => r.fullName)).toEqual(["Register One"]);
  });
});

describe("exceptions register", () => {
  it("lists today's adjustments, reversed receipt and voided invoice with who and why", async () => {
    const r = await getExceptionsRegister(db, exceptionsQuerySchema.parse({ from: today, to: today }));
    expect(r.adjustments.map((a) => [a.kind, a.category, a.amountCentavos, a.reason])).toEqual([
      ["credit", "service_outage", -10_000, "Outage"],
      ["debit", "penalty", 5_000, "Late payment"],
    ]);
    expect(r.adjustments[0]).toMatchObject({ date: today, subscriberName: "Register One", by: expect.any(String) });
    expect(r.reversals).toEqual([
      expect.objectContaining({ reversedOn: today, paymentDate: today, method: "cash", amountCentavos: 30_000, reason: "Wrong subscriber" }),
    ]);
    expect(r.reversals[0]!.receiptNumber).toMatch(/^RCPT-/);
    expect(r.voids).toEqual([expect.objectContaining({ voidedOn: today, amountCentavos: 99_900, reason: "Billed in error" })]);
    expect(r.totals).toEqual({
      debitAdjustmentsCentavos: 5_000,
      creditAdjustmentsCentavos: 10_000,
      reversedCentavos: 30_000,
      voidedCentavos: 99_900,
    });
  });

  it("dates each change the day it was made: nothing before today", async () => {
    const yesterday = addDays(today, -1);
    const r = await getExceptionsRegister(db, exceptionsQuerySchema.parse({ from: addDays(today, -30), to: yesterday }));
    expect([r.adjustments, r.reversals, r.voids]).toEqual([[], [], []]);
  });
});

describe("register routes", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };

  it("serves both to report.view, exports to report.export, audited", async () => {
    const viewer = await bearer("reg_viewer");
    expect((await app.inject({ method: "GET", url: "/reports/subscribers?status=archived", headers: viewer })).json().rows).toHaveLength(1);
    const exceptions = await app.inject({ method: "GET", url: `/reports/exceptions?from=${today}&to=${today}`, headers: viewer });
    expect(exceptions.json().voids).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/reports/subscribers/export?format=pdf", headers: viewer })).statusCode).toBe(403);

    const auditor = await bearer("reg_auditor");
    const list = await app.inject({ method: "GET", url: `/reports/subscribers/export?format=xlsx&status=active&areaId=${areaId}`, headers: auditor });
    expect(list.statusCode).toBe(200);
    expect(list.headers["content-disposition"]).toBe(`attachment; filename="subscriber-master-list-${today}.xlsx"`);
    const register = await app.inject({ method: "GET", url: `/reports/exceptions/export?from=${today}&to=${today}&format=pdf`, headers: auditor });
    expect(register.statusCode).toBe(200);
    expect(register.headers["content-disposition"]).toBe(`attachment; filename="exceptions-register-${today}_to_${today}.pdf"`);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "report.export"));
    expect(audits.map((a) => a.entityId)).toEqual(expect.arrayContaining(["subscriber-master-list", "exceptions-register"]));
    expect(audits).toHaveLength(2);
  });

  it("validates filters and ranges", async () => {
    const viewer = await bearer("reg_viewer");
    for (const url of [
      "/reports/subscribers?status=gone",
      "/reports/subscribers?areaId=zone",
      "/reports/exceptions?from=2026-10-31&to=2026-10-01",
      "/reports/exceptions?from=2026-10-01",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: viewer })).statusCode, url).toBe(400);
    }
  });
});
