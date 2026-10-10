import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  collectorCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs, collectionBatches, payments } from "../db/schema";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { createCollector } from "./service";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let collectorId: string;
let subscriberId: string;
let otherSubscriberId: string;
let collectionDate: string;
const tokens: Record<string, string> = {};

const as = (role: string) => ({ authorization: `Bearer ${tokens[role]}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const batchAudit = () => db.select().from(auditLogs).where(eq(auditLogs.entityType, "collection_batch"));

function call(role: string, method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: as(role), ...(payload ? { payload } : {}) });
}

/** A batch for the collector built by the supervisor, optionally moved along. */
async function batch(stage: "open" | "in_progress" | "submitted" = "open"): Promise<string> {
  const res = await call("supervisor", "POST", "/collection-batches", { collectorId, collectionDate });
  expect(res.statusCode).toBe(201);
  const id = res.json().batch.id as string;
  const steps = { open: [], in_progress: ["dispatch"], submitted: ["dispatch", "submit"] }[stage];
  for (const step of steps) {
    const moved = await call("supervisor", "POST", `/collection-batches/${id}/${step}`);
    if (moved.statusCode !== 200) throw new Error(`${step} failed: ${moved.body}`);
  }
  return id;
}

const reads = () =>
  [
    { method: "GET", url: "/collection-batches" },
    { method: "GET", url: `/collection-batches/${NIL_ID}` },
    { method: "GET", url: "/collection-reports/collectors?from=2026-10-01&to=2026-10-31" },
  ] as const;

const manageWrites = () =>
  [
    { method: "POST", url: "/collection-batches", payload: { collectorId: NIL_ID, collectionDate: "2026-10-01" } },
    { method: "POST", url: `/collection-batches/${NIL_ID}/accounts`, payload: { subscriberId: NIL_ID } },
    { method: "DELETE", url: `/collection-batches/${NIL_ID}/accounts/${NIL_ID}` },
    { method: "POST", url: `/collection-batches/${NIL_ID}/dispatch` },
    { method: "POST", url: `/collection-batches/${NIL_ID}/submit` },
    { method: "POST", url: `/collection-batches/${NIL_ID}/cancel`, payload: { reason: "Testing access" } },
    {
      method: "POST",
      url: `/collection-batches/${NIL_ID}/collections`,
      payload: { subscriberId: NIL_ID, method: "cash", amountCentavos: 100 },
    },
    { method: "POST", url: `/collection-batches/${NIL_ID}/remittances`, payload: { amountCentavos: 100 } },
    { method: "POST", url: `/collection-batches/${NIL_ID}/remittances/${NIL_ID}/void`, payload: { reason: "Testing access" } },
  ] as const;

const reconcileWrites = () =>
  [
    { method: "POST", url: `/collection-batches/${NIL_ID}/reconcile`, payload: { differenceCentavos: 0 } },
    { method: "POST", url: `/collection-batches/${NIL_ID}/close`, payload: { differenceCentavos: 0 } },
  ] as const;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles, collection_areas, collectors CASCADE`);
  const supervisorId = await createTestUser(db, "batch_supervisor", PASSWORD, "collection_supervisor");
  await createTestUser(db, "batch_admin", PASSWORD, "administrator");
  await createTestUser(db, "batch_cashier", PASSWORD, "cashier");
  await createTestUser(db, "batch_auditor", PASSWORD, "auditor");

  const dates = await pool.query<{ earlier: string }>(`SELECT (CURRENT_DATE - 1)::text AS earlier`);
  collectionDate = dates.rows[0]!.earlier;
  collectorId = (await createCollector(db, supervisorId, collectorCreateSchema.parse({ code: "COL-RT", fullName: "Route Collector" }))).id;
  const planId = (
    await createPlan(
      db,
      supervisorId,
      planCreateSchema.parse({ code: "inet-batchrt", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  const makeSubscriber = async (fullName: string, collector: string | null) => {
    const subscriber = await createSubscriber(
      db,
      supervisorId,
      subscriberCreateSchema.parse({
        fullName,
        billingDay: 5,
        assignedCollectorId: collector,
        address: { line1: "Purok 8", barangay: "Casisang", city: "Malaybalay" },
      }),
    );
    const service = await createServiceAccount(
      db,
      supervisorId,
      subscriber.id,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
    );
    return { id: subscriber.id, serviceId: service.id };
  };
  const owing = await makeSubscriber("Route Owing", collectorId);
  subscriberId = owing.id;
  otherSubscriberId = (await makeSubscriber("Route Other", null)).id;

  // One past-due ₱20,000.00 invoice, so a batch built for the collector has this subscriber on it.
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2000-01-01', '2000-01-31', $1) RETURNING id`,
    [supervisorId],
  );
  await pool.query(
    `INSERT INTO invoices (billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, total_centavos, created_by_user_id, status, invoice_number, finalized_at, finalized_by_user_id)
     VALUES ($1, $2, $3, '2000-01-01', '2000-01-31', '2000-01-01', '2000-01-05', 2000000, $4, 'unpaid', 'INV-RT0001', now(), $4)`,
    [cycle.rows[0]!.id, owing.id, owing.serviceId, supervisorId],
  );

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
  for (const role of ["supervisor", "admin", "cashier", "auditor"]) tokens[role] = await tokenFor(`batch_${role}`);
});

beforeEach(async () => {
  // Payments go too (they reference batches); the invoice's paid amount is put back.
  await db.execute(sql`TRUNCATE collection_batches, batch_accounts, collector_remittances, payments CASCADE`);
  await db.execute(sql`UPDATE invoices SET paid_centavos = 0, status = 'unpaid'`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("collection batch routes: authorization", () => {
  it("rejects requests with no token", async () => {
    for (const c of [...reads(), ...manageWrites(), ...reconcileWrites()]) {
      expect((await app.inject(c)).statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });

  it("rejects a cashier everywhere: no collection.view", async () => {
    for (const c of [...reads(), ...manageWrites(), ...reconcileWrites()]) {
      expect((await app.inject({ ...c, headers: as("cashier") })).statusCode, `${c.method} ${c.url}`).toBe(403);
    }
  });

  it("lets an auditor read but change nothing", async () => {
    expect((await app.inject({ ...reads()[0], headers: as("auditor") })).statusCode).toBe(200);
    expect((await app.inject({ ...reads()[2], headers: as("auditor") })).statusCode).toBe(200);
    for (const c of [...manageWrites(), ...reconcileWrites()]) {
      expect((await app.inject({ ...c, headers: as("auditor") })).statusCode, `${c.method} ${c.url}`).toBe(403);
    }
    expect(await db.select().from(collectionBatches)).toEqual([]);
  });

  it("lets an administrator run a batch but not reconcile or close it", async () => {
    const res = await call("admin", "POST", "/collection-batches", { collectorId, collectionDate });
    expect(res.statusCode).toBe(201);
    for (const c of reconcileWrites()) {
      expect((await app.inject({ ...c, headers: as("admin") })).statusCode, c.url).toBe(403);
    }
  });
});

describe("collection batch routes: supervisor", () => {
  it("validates bodies and ids", async () => {
    const noDate = await call("supervisor", "POST", "/collection-batches", { collectorId });
    expect(noDate.statusCode).toBe(400);
    expect(noDate.json().error).toBe("VALIDATION");
    expect((await call("supervisor", "GET", "/collection-batches/not-a-uuid")).statusCode).toBe(400);
    const backwards = await call("supervisor", "GET", "/collection-reports/collectors?from=2026-10-31&to=2026-10-01");
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().issues[0].path).toBe("to");

    const id = await batch("in_progress");
    const cheque = await call("supervisor", "POST", `/collection-batches/${id}/collections`, {
      subscriberId,
      method: "cheque",
      amountCentavos: 100,
    });
    expect(cheque.statusCode).toBe(400);
    expect(cheque.json().issues[0].path).toBe("referenceNumber");
  });

  it("maps service errors to their status codes", async () => {
    expect((await call("supervisor", "GET", `/collection-batches/${NIL_ID}`)).statusCode).toBe(404);
    const unknownCollector = await call("supervisor", "POST", "/collection-batches", { collectorId: NIL_ID, collectionDate });
    expect(unknownCollector.json()).toMatchObject({ error: "COLLECTOR_NOT_FOUND" });
    expect(unknownCollector.statusCode).toBe(404);

    const id = await batch("open");
    const early = await call("supervisor", "POST", `/collection-batches/${id}/submit`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("INVALID_TRANSITION");

    await call("supervisor", "POST", `/collection-batches/${id}/dispatch`);
    const future = await call("supervisor", "POST", `/collection-batches/${id}/collections`, {
      subscriberId,
      method: "cash",
      amountCentavos: 100,
      paymentDate: "2999-01-01",
    });
    expect(future.statusCode).toBe(422);
    expect(future.json().error).toBe("PAYMENT_DATE_IN_FUTURE");
    const notOnBatch = await call("supervisor", "POST", `/collection-batches/${id}/collections`, {
      subscriberId: otherSubscriberId,
      method: "cash",
      amountCentavos: 100,
    });
    expect(notOnBatch.json().error).toBe("NOT_ON_BATCH");
  });

  it("builds, edits and lists a batch", async () => {
    const created = await call("supervisor", "POST", "/collection-batches", { collectorId, collectionDate });
    expect(created.json().skipped).toEqual([]);
    const id = created.json().batch.id as string;
    expect(created.json().batch.accounts).toHaveLength(1);

    const added = await call("supervisor", "POST", `/collection-batches/${id}/accounts`, { subscriberId: otherSubscriberId });
    expect(added.statusCode).toBe(200);
    expect(added.json().accounts).toHaveLength(2);
    const removed = await call("supervisor", "DELETE", `/collection-batches/${id}/accounts/${otherSubscriberId}`);
    expect(removed.json().accounts).toHaveLength(1);

    const list = await call("auditor", "GET", "/collection-batches?status=open");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, items: [{ id, accountCount: 1, totalDueCentavos: 2_000_000 }] });
  });

  it("cancels with a required reason", async () => {
    const id = await batch("open");
    expect((await call("supervisor", "POST", `/collection-batches/${id}/cancel`, {})).statusCode).toBe(400);
    const res = await call("supervisor", "POST", `/collection-batches/${id}/cancel`, { reason: "Typhoon signal 2" });
    expect(res.json()).toMatchObject({ status: "cancelled", cancelled: { reason: "Typhoon signal 2" } });
  });

  it("AT-07 over HTTP: ₱20,000 collected and remitted reconciles at ₱0 and closes", async () => {
    const id = await batch("in_progress");
    const collected = await call("supervisor", "POST", `/collection-batches/${id}/collections`, {
      subscriberId,
      method: "cash",
      amountCentavos: 2_000_000,
      referenceNumber: "OR-5001",
    });
    expect(collected.statusCode).toBe(201);
    expect(collected.json().receiptNumber).toMatch(/^RCPT-/);
    expect(collected.json().paymentDate).toBe(collectionDate);

    await call("supervisor", "POST", `/collection-batches/${id}/submit`);
    const remitted = await call("supervisor", "POST", `/collection-batches/${id}/remittances`, { amountCentavos: 2_000_000 });
    expect(remitted.json().status).toBe("remitted");

    const reconciled = await call("supervisor", "POST", `/collection-batches/${id}/reconcile`, { differenceCentavos: 0 });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().reconciliation).toMatchObject({ differenceCentavos: 0, varianceKind: "balanced" });
    const closed = await call("supervisor", "POST", `/collection-batches/${id}/close`, { differenceCentavos: 0 });
    expect(closed.json().status).toBe("closed");

    expect((await batchAudit()).map((a) => a.action)).toEqual(
      expect.arrayContaining(["collection_batch.reconcile", "collection_batch.close"]),
    );
  });

  it("AT-08 over HTTP: a ₱500 shortage needs a reason and an explicit confirmation to close", async () => {
    const id = await batch("in_progress");
    await call("supervisor", "POST", `/collection-batches/${id}/collections`, { subscriberId, method: "cash", amountCentavos: 2_000_000 });
    await call("supervisor", "POST", `/collection-batches/${id}/submit`);
    await call("supervisor", "POST", `/collection-batches/${id}/remittances`, { amountCentavos: 1_950_000 });

    const asBalanced = await call("supervisor", "POST", `/collection-batches/${id}/reconcile`, { differenceCentavos: 0 });
    expect(asBalanced.statusCode).toBe(409);
    expect(asBalanced.json()).toMatchObject({ error: "DIFFERENCE_CHANGED", message: expect.stringContaining("₱500.00 shortage") });
    const noReason = await call("supervisor", "POST", `/collection-batches/${id}/reconcile`, { differenceCentavos: -50_000 });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().issues[0].path).toBe("varianceReason");

    const reconciled = await call("supervisor", "POST", `/collection-batches/${id}/reconcile`, {
      differenceCentavos: -50_000,
      varianceReason: "Collector short ₱500",
    });
    expect(reconciled.json().reconciliation).toMatchObject({ differenceCentavos: -50_000, varianceKind: "shortage" });

    const silent = await call("supervisor", "POST", `/collection-batches/${id}/close`, { differenceCentavos: 0 });
    expect(silent.statusCode).toBe(409);
    const closed = await call("supervisor", "POST", `/collection-batches/${id}/close`, { differenceCentavos: -50_000 });
    expect(closed.json()).toMatchObject({ status: "closed", reconciliation: { varianceKind: "shortage" } });
  });

  it("voids a remittance with a reason", async () => {
    const id = await batch("submitted");
    const remitted = await call("supervisor", "POST", `/collection-batches/${id}/remittances`, { amountCentavos: 500 });
    const remittanceId = remitted.json().remittances[0].id as string;
    const voided = await call("supervisor", "POST", `/collection-batches/${id}/remittances/${remittanceId}/void`, {
      reason: "Wrong amount",
    });
    expect(voided.json().money.remittedCentavos).toBe(0);
    const again = await call("supervisor", "POST", `/collection-batches/${id}/remittances/${remittanceId}/void`, {
      reason: "Wrong amount",
    });
    expect(again.statusCode).toBe(409);
    expect(await db.select().from(payments)).toEqual([]);
  });
});

describe("collector performance export", () => {
  const url = (format: string) => `/collection-reports/collectors/export?from=${collectionDate}&to=${collectionDate}&format=${format}`;

  it("lets supervisors (now holding report.export) and auditors export, audited; cashiers are refused", async () => {
    await batch("submitted");
    expect((await call("cashier", "GET", url("pdf"))).statusCode).toBe(403);

    const pdf = await call("supervisor", "GET", url("pdf"));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-disposition"]).toBe(
      `attachment; filename="collector-performance-${collectionDate}_to_${collectionDate}.pdf"`,
    );
    const xlsx = await call("auditor", "GET", url("xlsx"));
    expect(xlsx.statusCode).toBe(200);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, "collector-performance"));
    expect(audits.map((a) => (a.newValues as { format: string }).format).toSorted((a, b) => a.localeCompare(b))).toEqual(["pdf", "xlsx"]);
  });

  it("validates the range and the format", async () => {
    for (const bad of [
      `/collection-reports/collectors/export?from=${collectionDate}&to=${collectionDate}`,
      "/collection-reports/collectors/export?from=2026-10-31&to=2026-10-01&format=pdf",
    ]) {
      expect((await call("supervisor", "GET", bad)).statusCode, bad).toBe(400);
    }
  });
});
