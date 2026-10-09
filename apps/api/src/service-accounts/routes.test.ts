import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { planCreateSchema, subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs, serviceAccounts } from "../db/schema";
import { createPlan } from "../plans/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let admin: { authorization: string };
let subscriberId: string;
let addressId: string;
let internetPlanId: string;
let cablePlanId: string;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function accountCount() {
  return (await db.select().from(serviceAccounts)).length;
}

/** Every service account endpoint, for the authorization sweeps. */
function allCalls(headers: Record<string, string> = {}) {
  const create = { planId: NIL_ID, installationAddressId: NIL_ID };
  return [
    { method: "GET", url: "/service-accounts", headers },
    { method: "GET", url: `/service-accounts/${NIL_ID}`, headers },
    { method: "POST", url: `/subscribers/${NIL_ID}/service-accounts`, headers, payload: create },
    { method: "PATCH", url: `/service-accounts/${NIL_ID}`, headers, payload: { notes: "x" } },
    { method: "POST", url: `/service-accounts/${NIL_ID}/status`, headers, payload: { status: "active", reason: "xxx" } },
    { method: "POST", url: `/service-accounts/${NIL_ID}/rate`, headers, payload: { rateCentavos: 1, reason: "xxx" } },
    { method: "POST", url: `/service-accounts/${NIL_ID}/plan`, headers, payload: { planId: NIL_ID, reason: "xxx" } },
    { method: "POST", url: `/service-accounts/${NIL_ID}/collector`, headers, payload: { assignedCollectorId: null } },
  ] as const;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, collection_areas, collectors CASCADE`);
  const adminId = await createTestUser(db, "admin1", PASSWORD, "administrator");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");
  await createTestUser(db, "tech1", PASSWORD, "technician");
  await createTestUser(db, "viewer1", PASSWORD, "viewer");

  internetPlanId = (
    await createPlan(
      db,
      adminId,
      planCreateSchema.parse({ code: "inet-50", name: "Internet 50", serviceType: "internet", priceCentavos: 149900, speedMbps: 50 }),
    )
  ).id;
  cablePlanId = (
    await createPlan(
      db,
      adminId,
      planCreateSchema.parse({ code: "cable-1", name: "Cable", serviceType: "cable", priceCentavos: 45000, channelCount: 80 }),
    )
  ).id;
  const subscriber = await createSubscriber(
    db,
    adminId,
    subscriberCreateSchema.parse({
      fullName: "Lito Lapid",
      billingDay: 3,
      address: { line1: "Purok 4", barangay: "Base Camp", city: "Maramag" },
    }),
  );
  subscriberId = subscriber.id;
  addressId = subscriber.addresses[0]!.id;

  app = buildApp(
    testConfig(),
    { db, pool },
  );
  await app.ready();
  admin = bearer(await tokenFor("admin1"));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("service account routes: authorization", () => {
  it("rejects requests with no token", async () => {
    for (const call of allCalls()) {
      expect((await app.inject(call)).statusCode).toBe(401);
    }
  });

  it("rejects a viewer (no service permissions) everywhere", async () => {
    for (const call of allCalls(bearer(await tokenFor("viewer1")))) {
      expect((await app.inject(call)).statusCode).toBe(403);
    }
  });

  it("lets a cashier and a technician read but not change anything, status included", async () => {
    for (const user of ["cashier1", "tech1"]) {
      for (const call of allCalls(bearer(await tokenFor(user)))) {
        const status = (await app.inject(call)).statusCode;
        // Reads reach the service (NIL_ID is not found); every write is forbidden.
        expect(status).toBe(call.method === "GET" ? (call.url === "/service-accounts" ? 200 : 404) : 403);
      }
    }
    expect(await accountCount()).toBe(0);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityType, "service_account"));
    expect(audit).toHaveLength(0);
  });
});

describe("service account routes: administrator", () => {
  let id: string;

  it("creates a service account under the subscriber (201) at the plan's price", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/subscribers/${subscriberId}/service-accounts`,
      headers: admin,
      payload: { planId: internetPlanId, installationAddressId: addressId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending", currentRateCentavos: 149900, billingDay: 3 });
    expect(res.json().serviceNumber).toMatch(/^SVC-\d{6}$/);
    id = res.json().id as string;
  });

  it("rejects a bad body with VALIDATION and maps service errors", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: `/subscribers/${subscriberId}/service-accounts`,
      headers: admin,
      payload: { planId: "not-a-uuid", installationAddressId: addressId },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("VALIDATION");

    const missing = await app.inject({
      method: "POST",
      url: `/subscribers/${NIL_ID}/service-accounts`,
      headers: admin,
      payload: { planId: internetPlanId, installationAddressId: addressId },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("SUBSCRIBER_NOT_FOUND");
  });

  it("activates, changes rate and plan, and returns the history", async () => {
    const activate = await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/status`,
      headers: admin,
      payload: { status: "active", reason: "Installed", effectiveDate: "2026-10-02" },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({ activationDate: "2026-10-02", billingStartDate: "2026-10-02" });

    const badDate = await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/rate`,
      headers: admin,
      payload: { rateCentavos: 129900, reason: "Promo", effectiveDate: "2026-13-01" },
    });
    expect(badDate.statusCode).toBe(400);

    const rate = await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/rate`,
      headers: admin,
      payload: { rateCentavos: 129900, reason: "Promo" },
    });
    expect(rate.json().currentRateCentavos).toBe(129900);

    const plan = await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/plan`,
      headers: admin,
      payload: { planId: cablePlanId, reason: "Switching to cable" },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ serviceType: "cable", currentRateCentavos: 45000 });

    const detail = await app.inject({ method: "GET", url: `/service-accounts/${id}`, headers: admin });
    expect(detail.json().events.map((e: { eventType: string }) => e.eventType)).toEqual([
      "plan_change",
      "rate_change",
      "status_change",
      "created",
    ]);
  });

  it("maps a disallowed transition to 409 and a terminated account to read-only", async () => {
    const back = await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/status`,
      headers: admin,
      payload: { status: "pending", reason: "Undo" },
    });
    expect(back.statusCode).toBe(409);
    expect(back.json().error).toBe("INVALID_STATUS_CHANGE");

    await app.inject({
      method: "POST",
      url: `/service-accounts/${id}/status`,
      headers: admin,
      payload: { status: "terminated", reason: "Moved away" },
    });
    const edit = await app.inject({
      method: "PATCH",
      url: `/service-accounts/${id}`,
      headers: admin,
      payload: { notes: "Too late" },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("ACCOUNT_TERMINATED");
  });

  it("lists with filters from the query string, readable by a technician", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/service-accounts?subscriberId=${subscriberId}&serviceType=cable`,
      headers: bearer(await tokenFor("tech1")),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(res.json().items[0]).toMatchObject({ subscriberName: "Lito Lapid", status: "terminated" });

    const bad = await app.inject({ method: "GET", url: "/service-accounts?status=deleted", headers: admin });
    expect(bad.statusCode).toBe(400);
  });
});
