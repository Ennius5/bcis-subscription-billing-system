import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs, servicePlans } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let adminId: string;
let planId: string;

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

async function planAuditRows() {
  return db.select().from(auditLogs).where(eq(auditLogs.entityType, "plan"));
}

async function planCount() {
  return (await db.select().from(servicePlans)).length;
}

const inet = {
  code: "inet-10",
  name: "Internet 10 Mbps",
  serviceType: "internet",
  priceCentavos: 99900,
  speedMbps: 10,
};

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE service_plans CASCADE`);
  adminId = await createTestUser(db, "admin1", PASSWORD, "administrator");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");

  app = buildApp(
    { API_HOST: "127.0.0.1", API_PORT: 3000, DATABASE_URL: "unused", NODE_ENV: "test" },
    { db, pool },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("plan routes: authorization", () => {
  it("rejects requests with no token", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await app.inject({ method: "GET", url: "/plans" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/plans", payload: inet })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "PATCH", url: `/plans/${id}`, payload: { name: "X" } })).statusCode,
    ).toBe(401);
  });

  it("rejects a cashier calling plan endpoints directly, leaving no plan or audit row", async () => {
    const headers = bearer(await tokenFor("cashier1"));
    const id = "00000000-0000-4000-8000-000000000000";

    expect((await app.inject({ method: "GET", url: "/plans", headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/plans", headers, payload: inet })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PATCH", url: `/plans/${id}`, headers, payload: { name: "X" } }))
        .statusCode,
    ).toBe(403);

    expect(await planCount()).toBe(0);
    expect(await planAuditRows()).toHaveLength(0);
  });
});

describe("plan routes: administrator", () => {
  it("creates a plan (201) and writes an audit row naming the actor", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({ method: "POST", url: "/plans", headers, payload: inet });
    expect(res.statusCode).toBe(201);

    const plan = res.json();
    expect(plan.code).toBe("INET-10");
    expect(plan.priceCentavos).toBe(99900);
    planId = plan.id as string;

    const audit = await planAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("plan.create");
    expect(audit[0]?.actorUserId).toBe(adminId);
  });

  it("rejects a duplicate code with 409 and writes no extra audit row", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({ method: "POST", url: "/plans", headers, payload: inet });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CODE_TAKEN");
    expect(await planAuditRows()).toHaveLength(1);
    expect(await planCount()).toBe(1);
  });

  it("rejects invalid input with 400 and leaves nothing behind", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const negative = await app.inject({
      method: "POST",
      url: "/plans",
      headers,
      payload: { ...inet, code: "zz-bad", priceCentavos: -1 },
    });
    expect(negative.statusCode).toBe(400);
    expect(negative.json().error).toBe("VALIDATION");

    const badType = await app.inject({
      method: "POST",
      url: "/plans",
      headers,
      payload: { ...inet, code: "zz-sat", serviceType: "satellite" },
    });
    expect(badType.statusCode).toBe(400);

    expect(await planCount()).toBe(1);
    expect(await planAuditRows()).toHaveLength(1);
  });

  it("updates a price and audits the old and new values with the reason", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/plans/${planId}`,
      headers,
      payload: { priceCentavos: 109900, reason: "annual adjustment" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().priceCentavos).toBe(109900);

    const updates = (await planAuditRows()).filter((r) => r.action === "plan.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.reason).toBe("annual adjustment");
    expect(updates[0]?.oldValues).toEqual({ priceCentavos: 99900 });
    expect(updates[0]?.newValues).toEqual({ priceCentavos: 109900 });
  });

  it("rejects a channel count on an internet plan with 422 and leaves the plan unchanged", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/plans/${planId}`,
      headers,
      payload: { channelCount: 50 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INVALID_ATTRIBUTES");

    const [plan] = await db.select().from(servicePlans).where(eq(servicePlans.id, planId));
    expect(plan?.channelCount).toBeNull();
    expect((await planAuditRows()).filter((r) => r.action === "plan.update")).toHaveLength(1);
  });

  it("rejects an attempt to change the plan code with 400", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/plans/${planId}`,
      headers,
      payload: { code: "OTHER" },
    });
    expect(res.statusCode).toBe(400);

    const [plan] = await db.select().from(servicePlans).where(eq(servicePlans.id, planId));
    expect(plan?.code).toBe("INET-10");
  });

  it("returns 400 for a malformed id and 404 for an unknown id", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const malformed = await app.inject({
      method: "PATCH",
      url: "/plans/not-a-uuid",
      headers,
      payload: { name: "X" },
    });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PATCH",
      url: "/plans/00000000-0000-4000-8000-000000000000",
      headers,
      payload: { name: "X" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("NOT_FOUND");
  });

  it("lists active plans by default and supports includeInactive and serviceType filters", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const cable = await app.inject({
      method: "POST",
      url: "/plans",
      headers,
      payload: {
        code: "cab-1",
        name: "Cable Basic",
        serviceType: "cable",
        priceCentavos: 50000,
        channelCount: 80,
      },
    });
    expect(cable.statusCode).toBe(201);

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/plans/${planId}`,
      headers,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);

    const active = await app.inject({ method: "GET", url: "/plans", headers });
    expect(active.json().map((p: { code: string }) => p.code)).toEqual(["CAB-1"]);

    const all = await app.inject({ method: "GET", url: "/plans?includeInactive=true", headers });
    expect(all.json()).toHaveLength(2);

    const internetOnly = await app.inject({
      method: "GET",
      url: "/plans?includeInactive=true&serviceType=internet",
      headers,
    });
    expect(internetOnly.json().map((p: { code: string }) => p.code)).toEqual(["INET-10"]);

    const badFilter = await app.inject({ method: "GET", url: "/plans?serviceType=satellite", headers });
    expect(badFilter.statusCode).toBe(400);
  });
});