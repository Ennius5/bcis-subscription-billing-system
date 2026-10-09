import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { dbToday } from "../db/query_helpers";
import { auditLogs, invoices, ledgerEntries } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let lastMonth: string;
let subscriberId: string;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const billingAudit = async () =>
  (await db.select().from(auditLogs)).filter((a) => a.action.startsWith("billing.") || a.action.startsWith("invoice."));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  const adminId = await createTestUser(db, "bill_admin", PASSWORD, "administrator");
  await createTestUser(db, "bill_cashier", PASSWORD, "cashier");
  await createTestUser(db, "bill_auditor", PASSWORD, "auditor");
  await createTestUser(db, "bill_viewer", PASSWORD, "viewer");

  lastMonth = addMonths(periodOf(await dbToday(db)), -1);
  const plan = await createPlan(
    db,
    adminId,
    planCreateSchema.parse({ code: "inet-rt", name: "Internet 25", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    adminId,
    subscriberCreateSchema.parse({
      fullName: "Route Billing",
      billingDay: 5,
      address: { line1: "Purok 1", barangay: "Poblacion", city: "Maramag" },
    }),
  );
  subscriberId = subscriber.id;
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
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
  );

  app = buildApp(
    testConfig(),
    { db, pool },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const reads = () =>
  [
    { method: "GET", url: `/billing/summary?period=${lastMonth}` },
    { method: "GET", url: "/invoices" },
    { method: "GET", url: `/invoices/${NIL_ID}` },
    { method: "GET", url: `/subscribers/${subscriberId}/ledger` },
  ] as const;

const writes = () =>
  [
    { method: "POST", url: "/billing/generate", payload: { period: lastMonth } },
    { method: "POST", url: "/billing/discard-drafts", payload: { period: lastMonth } },
    { method: "POST", url: "/billing/finalize", payload: { period: lastMonth } },
    { method: "POST", url: `/invoices/${NIL_ID}/void`, payload: { reason: "Testing access" } },
  ] as const;

describe("billing routes: authorization", () => {
  it("rejects requests with no token", async () => {
    for (const call of [...reads(), ...writes()]) {
      expect((await app.inject(call)).statusCode, call.url).toBe(401);
    }
  });

  it("rejects a viewer everywhere: no billing.view", async () => {
    const headers = bearer(await tokenFor("bill_viewer"));
    for (const call of [...reads(), ...writes()]) {
      expect((await app.inject({ ...call, headers })).statusCode, call.url).toBe(403);
    }
  });

  it("lets a cashier and an auditor read but never generate, finalize or void", async () => {
    for (const username of ["bill_cashier", "bill_auditor"]) {
      const headers = bearer(await tokenFor(username));
      const summary = await app.inject({ ...reads()[0], headers });
      expect(summary.statusCode, username).toBe(200);
      expect((await app.inject({ ...reads()[1], headers })).statusCode, username).toBe(200);
      for (const call of writes()) {
        expect((await app.inject({ ...call, headers })).statusCode, `${username} ${call.url}`).toBe(403);
      }
    }
    expect(await db.select().from(invoices)).toEqual([]);
    expect(await billingAudit()).toEqual([]);
  });
});

describe("billing routes: administrator", () => {
  let headers: { authorization: string };
  let invoiceId: string;

  beforeAll(async () => {
    headers = bearer(await tokenFor("bill_admin"));
  });

  it("validates the period", async () => {
    const bad = await app.inject({ method: "POST", url: "/billing/generate", headers, payload: { period: "2026-13" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("VALIDATION");
    const missing = await app.inject({ method: "GET", url: "/billing/summary", headers });
    expect(missing.statusCode).toBe(400);
  });

  it("maps billing errors to their status codes", async () => {
    const tooFar = await app.inject({
      method: "POST",
      url: "/billing/generate",
      headers,
      payload: { period: addMonths(lastMonth, 3) },
    });
    expect(tooFar.statusCode).toBe(422);
    expect(tooFar.json().error).toBe("PERIOD_TOO_FAR");

    const notGenerated = await app.inject({ method: "POST", url: "/billing/finalize", headers, payload: { period: "2020-01" } });
    expect(notGenerated.statusCode).toBe(404);
    expect(notGenerated.json().error).toBe("PERIOD_NOT_GENERATED");
  });

  it("generates, finalizes, lists and opens an invoice", async () => {
    const generated = await app.inject({ method: "POST", url: "/billing/generate", headers, payload: { period: lastMonth } });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().drafts).toEqual({ count: 1, totalCentavos: 99_900 });

    const finalized = await app.inject({ method: "POST", url: "/billing/finalize", headers, payload: { period: lastMonth } });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({ finalizedNow: 1, skipped: [] });
    const number = finalized.json().firstNumber as string;

    const list = await app.inject({ method: "GET", url: `/invoices?period=${lastMonth}&status=overdue`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ invoiceNumber: number, displayStatus: "overdue" });
    invoiceId = list.json().items[0].id as string;

    const detail = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().items).toHaveLength(1);

    expect((await app.inject({ method: "GET", url: `/invoices/${NIL_ID}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/invoices/not-a-uuid", headers })).statusCode).toBe(400);
  });

  it("shows the ledger with a running balance, and a date range", async () => {
    const ledger = await app.inject({ method: "GET", url: `/subscribers/${subscriberId}/ledger`, headers });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toMatchObject({ closingBalanceCentavos: 99_900, openingBalanceCentavos: 0 });

    const ranged = await app.inject({
      method: "GET",
      url: `/subscribers/${subscriberId}/ledger?from=${addMonths(lastMonth, 1)}-01`,
      headers,
    });
    expect(ranged.json()).toMatchObject({ openingBalanceCentavos: 99_900, entries: [] });

    const backwards = await app.inject({
      method: "GET",
      url: `/subscribers/${subscriberId}/ledger?from=2026-09-30&to=2026-09-01`,
      headers,
    });
    expect(backwards.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/subscribers/${NIL_ID}/ledger`, headers })).statusCode).toBe(404);
  });

  it("voids with a required reason and credits the ledger", async () => {
    const noReason = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/void`, headers, payload: {} });
    expect(noReason.statusCode).toBe(400);

    const voided = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/void`,
      headers,
      payload: { reason: "Billed to the wrong account" },
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().status).toBe("void");

    const again = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/void`,
      headers,
      payload: { reason: "Again" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("INVOICE_ALREADY_VOID");

    const credits = await db.select().from(ledgerEntries).where(eq(ledgerEntries.entryType, "invoice_void"));
    expect(credits).toHaveLength(1);
    const audit = (await billingAudit()).find((a) => a.action === "invoice.void");
    expect(audit?.reason).toBe("Billed to the wrong account");
  });
});
