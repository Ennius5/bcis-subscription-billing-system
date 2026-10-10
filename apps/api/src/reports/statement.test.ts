import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
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
import { auditLogs } from "../db/schema";
import { postPayment, reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { getStatementOfAccount } from "./statement";

// One subscriber on a 999.00 plan, billed for the two months before this one (A and B):
//   A-10   P1 500.00 (backdated)  -> invoice A partly paid
//   B-15   P2 2,000.00            -> A rest 499, B 999, credit 502
//   today  P1 reversed            -> A loses 500, the 502 credit re-applies 500 to A, credit 2
// Every statement date must agree with the ledger: open invoices - credit = closing balance.

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let subscriberId: string;
let monthA: string;
let monthB: string;
let today: string;

const soa = (range: { from?: string; to?: string } = {}) => getStatementOfAccount(db, subscriberId, range);

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  const actorId = await createTestUser(db, "soa_admin", PASSWORD, "administrator");
  await createTestUser(db, "soa_cashier", PASSWORD, "cashier");
  await createTestUser(db, "soa_viewer", PASSWORD, "viewer");

  today = await dbToday(db);
  monthB = addMonths(periodOf(today), -1);
  monthA = addMonths(monthB, -1);

  const plan = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({ code: "soa-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName: "Statement Demo",
      billingDay: 5,
      address: { line1: "Purok 4", barangay: "Poblacion", city: "Quezon", province: "Bukidnon" },
    }),
  );
  subscriberId = subscriber.id;
  const service = await createServiceAccount(
    db,
    actorId,
    subscriberId,
    serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    actorId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(monthA).start }),
  );

  const bill = async (period: string) => {
    await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period }));
    await finalizeBilling(db, actorId, billingRunSchema.parse({ period }));
  };
  const pay = (amountCentavos: number, paymentDate: string) =>
    postPayment(db, actorId, paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos, paymentDate }));

  await bill(monthA);
  const p1 = await pay(50_000, `${monthA}-10`);
  await bill(monthB);
  await pay(200_000, `${monthB}-15`);
  await reversePayment(db, actorId, p1.id, { reason: "Bounced" });

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("statement of account", () => {
  it("as of the end of month A: A open 499.00 after the backdated payment, aged from its due date", async () => {
    const s = await soa({ to: periodBounds(monthA).end });
    expect(s.asOf).toBe(periodBounds(monthA).end);
    expect(s.openInvoices).toEqual([
      expect.objectContaining({
        dueDate: `${monthA}-05`,
        amountCentavos: 99_900,
        paidCentavos: 50_000,
        openCentavos: 49_900,
        bucket: "days_1_30",
      }),
    ]);
    expect(s.unappliedCreditCentavos).toBe(0);
    expect(s.ledger.closingBalanceCentavos).toBe(49_900);
    expect(s.reconciles).toBe(true);
  });

  it("as of the end of month B: everything paid, 502.00 credit, before the reversal happened", async () => {
    const s = await soa({ to: periodBounds(monthB).end });
    expect(s.openInvoices).toEqual([]);
    expect(s.unappliedCreditCentavos).toBe(50_200);
    expect(s.ledger.closingBalanceCentavos).toBe(-50_200);
    expect(s.reconciles).toBe(true);
  });

  it("as of today: the reversal took 500.00 off A and the credit covered it, 2.00 credit left", async () => {
    const s = await soa();
    expect(s.asOf).toBe(today);
    expect(s.openInvoices).toEqual([]);
    expect(s.unappliedCreditCentavos).toBe(200);
    expect(s.ledger.closingBalanceCentavos).toBe(-200);
    expect(s.reconciles).toBe(true);
    expect(s.subscriber).toMatchObject({ fullName: "Statement Demo", address: "Purok 4, Poblacion, Quezon, Bukidnon" });
  });

  it("carries an opening balance into a range and lists only that range's activity", async () => {
    const s = await soa({ from: periodBounds(monthB).start, to: periodBounds(monthB).end });
    expect(s.ledger.openingBalanceCentavos).toBe(49_900);
    expect(s.ledger.entries.map((e) => e.entryType)).toEqual(["invoice", "payment"]);
    expect(s.ledger.closingBalanceCentavos).toBe(-50_200);
  });
});

describe("statement routes", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };

  it("lets a cashier (billing.view) view and print, refuses a viewer, and audits against the subscriber", async () => {
    const cashier = await bearer("soa_cashier");
    const view = await app.inject({ method: "GET", url: `/subscribers/${subscriberId}/statement`, headers: cashier });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ asOf: today, reconciles: true });

    const viewer = await bearer("soa_viewer");
    expect((await app.inject({ method: "GET", url: `/subscribers/${subscriberId}/statement`, headers: viewer })).statusCode).toBe(403);

    const to = periodBounds(monthA).end;
    const pdf = await app.inject({ method: "GET", url: `/subscribers/${subscriberId}/statement/export?to=${to}&format=pdf`, headers: cashier });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-disposition"]).toMatch(new RegExp(`^attachment; filename="soa-[A-Z0-9-]+-${to}\\.pdf"$`));
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "soa.export"), eq(auditLogs.entityId, subscriberId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "subscriber", newValues: { format: "pdf", filters: { to } } });
  });

  it("returns 404 for an unknown subscriber and 400 for bad ranges", async () => {
    const cashier = await bearer("soa_cashier");
    const missing = await app.inject({
      method: "GET",
      url: "/subscribers/00000000-0000-4000-8000-000000000000/statement/export?format=pdf",
      headers: cashier,
    });
    expect(missing.statusCode).toBe(404);
    for (const url of [
      `/subscribers/${subscriberId}/statement?from=2026-10-31&to=2026-10-01`,
      `/subscribers/${subscriberId}/statement/export`,
      "/subscribers/not-a-uuid/statement",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: cashier })).statusCode, url).toBe(400);
    }
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "soa.export"));
    expect(audits).toHaveLength(1);
  });
});
