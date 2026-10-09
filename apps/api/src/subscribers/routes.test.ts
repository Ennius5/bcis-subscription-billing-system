import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { areaCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createArea, updateArea } from "../collection/service";
import { auditLogs, subscribers } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let adminId: string;
let areaId: string;
let inactiveAreaId: string;
let admin: { authorization: string };

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

async function subscriberAudit() {
  return db.select().from(auditLogs).where(eq(auditLogs.entityType, "subscriber"));
}

async function subscriberCount() {
  return (await db.select().from(subscribers)).length;
}

const newSubscriber = {
  fullName: "Rosa Dalisay",
  billingDay: 10,
  address: { line1: "Purok 3", barangay: "Base Camp", city: "Maramag" },
  contacts: [{ type: "mobile", value: "09181234567", isPrimary: true }],
};

/** Every subscriber endpoint, for the authorization sweeps. */
function allCalls(headers: Record<string, string> = {}) {
  return [
    { method: "GET", url: "/subscribers", headers },
    { method: "GET", url: `/subscribers/${NIL_ID}`, headers },
    { method: "GET", url: `/subscribers/${NIL_ID}/history`, headers },
    { method: "POST", url: "/subscribers", headers, payload: newSubscriber },
    { method: "PATCH", url: `/subscribers/${NIL_ID}`, headers, payload: { notes: "x" } },
    { method: "POST", url: `/subscribers/${NIL_ID}/status`, headers, payload: { status: "inactive", reason: "x" } },
    {
      method: "POST",
      url: `/subscribers/${NIL_ID}/assignment`,
      headers,
      payload: { collectionAreaId: null, assignedCollectorId: null },
    },
    { method: "POST", url: `/subscribers/${NIL_ID}/addresses`, headers, payload: newSubscriber.address },
    { method: "PATCH", url: `/subscribers/${NIL_ID}/addresses/${NIL_ID}`, headers, payload: { landmark: "x" } },
    { method: "POST", url: `/subscribers/${NIL_ID}/contacts`, headers, payload: newSubscriber.contacts[0] },
    { method: "PATCH", url: `/subscribers/${NIL_ID}/contacts/${NIL_ID}`, headers, payload: { contactName: "x" } },
  ] as const;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, collection_areas, collectors CASCADE`);
  adminId = await createTestUser(db, "admin1", PASSWORD, "administrator");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");
  await createTestUser(db, "tech1", PASSWORD, "technician");

  areaId = (await createArea(db, adminId, areaCreateSchema.parse({ code: "zone-1", name: "Zone 1" }))).id;
  inactiveAreaId = (await createArea(db, adminId, areaCreateSchema.parse({ code: "zone-x", name: "Closed" }))).id;
  await updateArea(db, adminId, inactiveAreaId, { isActive: false });

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

describe("subscriber routes: authorization", () => {
  it("rejects requests with no token", async () => {
    for (const call of allCalls()) {
      expect((await app.inject(call)).statusCode).toBe(401);
    }
  });

  it("rejects a technician (no subscriber permissions) everywhere, leaving nothing behind", async () => {
    for (const call of allCalls(bearer(await tokenFor("tech1")))) {
      expect((await app.inject(call)).statusCode).toBe(403);
    }
    expect(await subscriberCount()).toBe(0);
    expect(await subscriberAudit()).toHaveLength(0);
  });

  it("lets a cashier read subscribers but not change them", async () => {
    const headers = bearer(await tokenFor("cashier1"));
    for (const call of allCalls(headers)) {
      const status = (await app.inject(call)).statusCode;
      // Reads reach the service (NIL_ID is not found); every write is forbidden.
      expect(status).toBe(call.method === "GET" ? (call.url === "/subscribers" ? 200 : 404) : 403);
    }
    expect(await subscriberCount()).toBe(0);
  });
});

describe("subscriber routes: administrator", () => {
  let id: string;

  it("creates a subscriber (201) with an account number", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/subscribers",
      headers: admin,
      payload: { ...newSubscriber, collectionAreaId: areaId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().accountNumber).toMatch(/^BCIS-\d{6}$/);
    expect(res.json().areaCode).toBe("ZONE-1");
    id = res.json().id as string;
  });

  it("rejects an invalid body with VALIDATION issues", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/subscribers",
      headers: admin,
      payload: { ...newSubscriber, billingDay: 31 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION");
    expect(res.json().issues[0].path).toBe("billingDay");
  });

  it("maps service errors to their status and code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/subscribers",
      headers: admin,
      payload: { ...newSubscriber, collectionAreaId: inactiveAreaId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "AREA_INACTIVE" });
    expect(await subscriberCount()).toBe(1);
  });

  it("lists with filters from the query string", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subscribers?collectionAreaId=${areaId}&pageSize=10`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(res.json().items[0].primaryContact).toBe("09181234567");

    const bad = await app.inject({ method: "GET", url: "/subscribers?pageSize=500", headers: admin });
    expect(bad.statusCode).toBe(400);
  });

  it("returns the detail, and 404 or 400 for unknown or malformed ids", async () => {
    const res = await app.inject({ method: "GET", url: `/subscribers/${id}`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().addresses).toHaveLength(1);

    const missing = await app.inject({ method: "GET", url: `/subscribers/${NIL_ID}`, headers: admin });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("NOT_FOUND");

    const malformed = await app.inject({ method: "GET", url: "/subscribers/not-a-uuid", headers: admin });
    expect(malformed.statusCode).toBe(400);
  });

  it("updates, changes assignment and manages addresses and contacts", async () => {
    const update = await app.inject({
      method: "PATCH",
      url: `/subscribers/${id}`,
      headers: admin,
      payload: { notes: "Gate is blue" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().notes).toBe("Gate is blue");

    const assignment = await app.inject({
      method: "POST",
      url: `/subscribers/${id}/assignment`,
      headers: admin,
      payload: { collectionAreaId: null, assignedCollectorId: null, reason: "Re-routing" },
    });
    expect(assignment.statusCode).toBe(200);
    expect(assignment.json().collectionAreaId).toBeNull();

    const added = await app.inject({
      method: "POST",
      url: `/subscribers/${id}/addresses`,
      headers: admin,
      payload: { line1: "Purok 5", barangay: "Panalsalan", city: "Maramag", isPrimary: true },
    });
    expect(added.statusCode).toBe(201);
    const oldPrimary = added.json().addresses.find((a: { isPrimary: boolean }) => !a.isPrimary).id;

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/subscribers/${id}/addresses/${oldPrimary}`,
      headers: admin,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);

    const primaryId = added.json().addresses.find((a: { isPrimary: boolean }) => a.isPrimary).id;
    const blocked = await app.inject({
      method: "PATCH",
      url: `/subscribers/${id}/addresses/${primaryId}`,
      headers: admin,
      payload: { isActive: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("PRIMARY_CANNOT_DEACTIVATE");

    const contact = await app.inject({
      method: "POST",
      url: `/subscribers/${id}/contacts`,
      headers: admin,
      payload: { type: "email", value: "rosa@example.com" },
    });
    expect(contact.statusCode).toBe(201);
    const emailId = contact.json().contacts.find((c: { type: string }) => c.type === "email").id;

    const badValue = await app.inject({
      method: "PATCH",
      url: `/subscribers/${id}/contacts/${emailId}`,
      headers: admin,
      payload: { value: "not an email" },
    });
    expect(badValue.statusCode).toBe(422);
    expect(badValue.json().error).toBe("INVALID_CONTACT_VALUE");
  });

  it("changes status and rejects a disallowed transition with 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/subscribers/${id}/status`,
      headers: admin,
      payload: { status: "terminated", reason: "Contract ended" },
    });
    expect(res.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "POST",
      url: `/subscribers/${id}/status`,
      headers: admin,
      payload: { status: "active", reason: "Changed mind" },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error).toBe("INVALID_STATUS_CHANGE");
  });

  it("returns the history newest first with the actor, readable by a cashier", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subscribers/${id}/history`,
      headers: bearer(await tokenFor("cashier1")),
    });
    expect(res.statusCode).toBe(200);
    const actions = res.json().map((row: { action: string }) => row.action);
    expect(actions).toEqual([
      "subscriber.status_change",
      "subscriber.contact_add",
      "subscriber.address_update",
      "subscriber.address_add",
      "subscriber.assignment_change",
      "subscriber.update",
      "subscriber.create",
    ]);
    expect(res.json()[0]).toMatchObject({ actorUsername: "admin1", reason: "Contract ended" });
  });
});
