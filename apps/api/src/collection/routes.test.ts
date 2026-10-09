import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs, collectionAreas, collectors, users } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let adminId: string;
let loginUserId: string;
let areaId: string;
let col1Id: string;
let col2Id: string;

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

async function auditRows(entityType: "collection_area" | "collector") {
  return db.select().from(auditLogs).where(eq(auditLogs.entityType, entityType));
}

async function areaCount() {
  return (await db.select().from(collectionAreas)).length;
}

async function collectorCount() {
  return (await db.select().from(collectors)).length;
}

const zone1 = { code: "zone-1", name: "Zone 1 - Poblacion" };

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE collection_areas, collectors CASCADE`);
  adminId = await createTestUser(db, "admin1", PASSWORD, "administrator");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");
  await createTestUser(db, "auditor1", PASSWORD, "auditor");
  loginUserId = await createTestUser(db, "collector_login", PASSWORD, "collection_supervisor");

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

describe("collection routes: authorization", () => {
  it("rejects requests with no token", async () => {
    const calls = [
      { method: "GET", url: "/collection-areas" },
      { method: "POST", url: "/collection-areas", payload: zone1 },
      { method: "PATCH", url: `/collection-areas/${NIL_ID}`, payload: { name: "X" } },
      { method: "GET", url: "/collectors" },
      { method: "POST", url: "/collectors", payload: { code: "col-x", fullName: "X" } },
      { method: "PATCH", url: `/collectors/${NIL_ID}`, payload: { fullName: "X" } },
    ] as const;
    for (const call of calls) {
      expect((await app.inject(call)).statusCode).toBe(401);
    }
  });

  it("rejects a cashier on every collection endpoint, leaving no rows or audit entries", async () => {
    const headers = bearer(await tokenFor("cashier1"));
    const calls = [
      { method: "GET", url: "/collection-areas", headers },
      { method: "POST", url: "/collection-areas", headers, payload: zone1 },
      { method: "PATCH", url: `/collection-areas/${NIL_ID}`, headers, payload: { name: "X" } },
      { method: "GET", url: "/collectors", headers },
      { method: "POST", url: "/collectors", headers, payload: { code: "col-x", fullName: "X" } },
      { method: "PATCH", url: `/collectors/${NIL_ID}`, headers, payload: { fullName: "X" } },
    ] as const;
    for (const call of calls) {
      expect((await app.inject(call)).statusCode).toBe(403);
    }

    expect(await areaCount()).toBe(0);
    expect(await collectorCount()).toBe(0);
    expect(await auditRows("collection_area")).toHaveLength(0);
    expect(await auditRows("collector")).toHaveLength(0);
  });

  it("lets an auditor read but not change collection data", async () => {
    const headers = bearer(await tokenFor("auditor1"));

    expect((await app.inject({ method: "GET", url: "/collection-areas", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/collectors", headers })).statusCode).toBe(200);

    expect(
      (await app.inject({ method: "POST", url: "/collection-areas", headers, payload: zone1 })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/collectors",
          headers,
          payload: { code: "col-x", fullName: "X" },
        })
      ).statusCode,
    ).toBe(403);

    expect(await areaCount()).toBe(0);
    expect(await collectorCount()).toBe(0);
  });
});

describe("collection area routes: administrator", () => {
  it("creates an area (201) and writes an audit row naming the actor", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({ method: "POST", url: "/collection-areas", headers, payload: zone1 });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe("ZONE-1");
    areaId = res.json().id as string;

    const audit = await auditRows("collection_area");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("collection_area.create");
    expect(audit[0]?.actorUserId).toBe(adminId);
  });

  it("rejects a duplicate code with 409 and writes no extra audit row", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({ method: "POST", url: "/collection-areas", headers, payload: zone1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CODE_TAKEN");
    expect(await areaCount()).toBe(1);
    expect(await auditRows("collection_area")).toHaveLength(1);
  });

  it("rejects invalid input with 400 and leaves nothing behind", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const badCode = await app.inject({
      method: "POST",
      url: "/collection-areas",
      headers,
      payload: { code: "a b", name: "X" },
    });
    expect(badCode.statusCode).toBe(400);
    expect(badCode.json().error).toBe("VALIDATION");

    const noName = await app.inject({
      method: "POST",
      url: "/collection-areas",
      headers,
      payload: { code: "zone-2" },
    });
    expect(noName.statusCode).toBe(400);

    expect(await areaCount()).toBe(1);
    expect(await auditRows("collection_area")).toHaveLength(1);
  });

  it("updates a name and audits the old and new values with the reason", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/collection-areas/${areaId}`,
      headers,
      payload: { name: "Zone 1 - Centro", reason: "renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Zone 1 - Centro");

    const updates = (await auditRows("collection_area")).filter((r) => r.action === "collection_area.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.reason).toBe("renamed");
    expect(updates[0]?.oldValues).toEqual({ name: "Zone 1 - Poblacion" });
    expect(updates[0]?.newValues).toEqual({ name: "Zone 1 - Centro" });
  });

  it("rejects an attempt to change the area code with 400", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/collection-areas/${areaId}`,
      headers,
      payload: { code: "OTHER" },
    });
    expect(res.statusCode).toBe(400);

    const [area] = await db.select().from(collectionAreas).where(eq(collectionAreas.id, areaId));
    expect(area?.code).toBe("ZONE-1");
  });

  it("returns 400 for a malformed id and 404 for an unknown id", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const malformed = await app.inject({
      method: "PATCH",
      url: "/collection-areas/not-a-uuid",
      headers,
      payload: { name: "X" },
    });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PATCH",
      url: `/collection-areas/${NIL_ID}`,
      headers,
      payload: { name: "X" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("NOT_FOUND");
  });

  it("lists active areas by default and supports includeInactive", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const second = await app.inject({
      method: "POST",
      url: "/collection-areas",
      headers,
      payload: { code: "zone-2", name: "Zone 2" },
    });
    expect(second.statusCode).toBe(201);

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/collection-areas/${areaId}`,
      headers,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);

    const active = await app.inject({ method: "GET", url: "/collection-areas", headers });
    expect(active.json().map((a: { code: string }) => a.code)).toEqual(["ZONE-2"]);

    const all = await app.inject({ method: "GET", url: "/collection-areas?includeInactive=true", headers });
    expect(all.json()).toHaveLength(2);

    const badFilter = await app.inject({ method: "GET", url: "/collection-areas?includeInactive=yes", headers });
    expect(badFilter.statusCode).toBe(400);
  });
});

describe("collector routes: administrator", () => {
  it("creates a collector without a login (201) and audits it", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "POST",
      url: "/collectors",
      headers,
      payload: { code: "col-1", fullName: "Juan Dela Cruz" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe("COL-1");
    expect(res.json().userId).toBeNull();
    expect(res.json().username).toBeNull();
    col1Id = res.json().id as string;

    const audit = await auditRows("collector");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("collector.create");
    expect(audit[0]?.actorUserId).toBe(adminId);
  });

  it("creates a collector linked to a user and returns the username", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "POST",
      url: "/collectors",
      headers,
      payload: {
        code: "col-2",
        fullName: "Maria Santos",
        contactNumber: "09170000000",
        userId: loginUserId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().userId).toBe(loginUserId);
    expect(res.json().username).toBe("collector_login");
    col2Id = res.json().id as string;
  });

  it("rejects a user who is already linked with 409, and an unknown user with 422", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const taken = await app.inject({
      method: "POST",
      url: "/collectors",
      headers,
      payload: { code: "col-3", fullName: "Third", userId: loginUserId },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("USER_ALREADY_LINKED");

    const unknown = await app.inject({
      method: "POST",
      url: "/collectors",
      headers,
      payload: { code: "col-4", fullName: "Fourth", userId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toBe("USER_NOT_FOUND");

    expect(await collectorCount()).toBe(2);
    expect(await auditRows("collector")).toHaveLength(2);
  });

  it("rejects a malformed user id with 400", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "POST",
      url: "/collectors",
      headers,
      payload: { code: "col-5", fullName: "Fifth", userId: "abc" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION");
    expect(await collectorCount()).toBe(2);
  });

  it("unlinks a login with null and audits the old and new user ids", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({
      method: "PATCH",
      url: `/collectors/${col2Id}`,
      headers,
      payload: { userId: null, reason: "left company" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBeNull();

    const updates = (await auditRows("collector")).filter((r) => r.action === "collector.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.reason).toBe("left company");
    expect(updates[0]?.oldValues).toEqual({ userId: loginUserId });
    expect(updates[0]?.newValues).toEqual({ userId: null });
  });

  it("returns 400 for a malformed id and 404 for an unknown id", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const malformed = await app.inject({
      method: "PATCH",
      url: "/collectors/not-a-uuid",
      headers,
      payload: { fullName: "X" },
    });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PATCH",
      url: `/collectors/${NIL_ID}`,
      headers,
      payload: { fullName: "X" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("NOT_FOUND");
  });

  it("lists active collectors by default and supports includeInactive", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/collectors/${col2Id}`,
      headers,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);

    const active = await app.inject({ method: "GET", url: "/collectors", headers });
    expect(active.json().map((c: { code: string }) => c.code)).toEqual(["COL-1"]);

    const all = await app.inject({ method: "GET", url: "/collectors?includeInactive=true", headers });
    expect(all.json()).toHaveLength(2);
    expect(col1Id).toBeTruthy();
  });
});

describe("collector login picker", () => {
  it("rejects no token, a cashier, and an auditor (view-only)", async () => {
    const url = "/collectors/available-users";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);

    const cashier = bearer(await tokenFor("cashier1"));
    expect((await app.inject({ method: "GET", url, headers: cashier })).statusCode).toBe(403);

    const auditor = bearer(await tokenFor("auditor1"));
    expect((await app.inject({ method: "GET", url, headers: auditor })).statusCode).toBe(403);
  });

  it("returns only id, username and fullName for unlinked active users", async () => {
    const headers = bearer(await tokenFor("admin1"));
    const res = await app.inject({ method: "GET", url: "/collectors/available-users", headers });
    expect(res.statusCode).toBe(200);

    const rows = res.json() as { id: string; username: string; fullName: string }[];
    expect(rows.map((u) => u.username)).toEqual(["admin1", "auditor1", "cashier1", "collector_login"]);
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(["fullName", "id", "username"]);
  });

  it("excludes users who are linked to a collector or are inactive", async () => {
    const headers = bearer(await tokenFor("admin1"));

    const link = await app.inject({
      method: "PATCH",
      url: `/collectors/${col1Id}`,
      headers,
      payload: { userId: loginUserId },
    });
    expect(link.statusCode).toBe(200);

    await createTestUser(db, "inactive_user", PASSWORD, "viewer");
    await db.update(users).set({ isActive: false }).where(eq(users.username, "inactive_user"));

    const res = await app.inject({ method: "GET", url: "/collectors/available-users", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((u: { username: string }) => u.username)).toEqual([
      "admin1",
      "auditor1",
      "cashier1",
    ]);
  });
});