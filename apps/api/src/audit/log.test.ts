import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auditLogQuerySchema, userActivityQuerySchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs } from "../db/schema";
import { getUserActivity } from "../reports/user-activity";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { listAuditLogs } from "./log";

// Audit rows at fixed past times. 2001-03-01T16:30Z is 00:30 on 2 March in Manila, so it
// belongs to 2 March there even though it is still 1 March in UTC.

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let adminId: string;
let cashierId: string;

const list = (query: Record<string, unknown>) => listAuditLogs(db, auditLogQuerySchema.parse(query));

beforeAll(async () => {
  await prepareTestDatabase(db);
  adminId = await createTestUser(db, "aud_admin", PASSWORD, "administrator");
  cashierId = await createTestUser(db, "aud_cashier", PASSWORD, "cashier");
  await createTestUser(db, "aud_auditor", PASSWORD, "auditor");
  await createTestUser(db, "aud_viewer", PASSWORD, "viewer");

  const insert = (occurredAt: string, actor: string | null, action: string, entityType: string, entityId: string | null) =>
    pool.query(
      `INSERT INTO audit_logs (occurred_at, actor_user_id, action, entity_type, entity_id, reason, old_values, new_values)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [occurredAt, actor, action, entityType, entityId, action === "invoice.void" ? "Billed in error" : null,
       action === "invoice.void" ? { status: "unpaid" } : null, { status: action }],
    );
  await insert("2001-03-01T02:00:00Z", adminId, "payment.post", "payment", "pay-1"); // 1 Mar Manila
  await insert("2001-03-01T16:30:00Z", adminId, "invoice.void", "invoice", "inv-1"); // 2 Mar Manila
  await insert("2001-03-02T03:00:00Z", cashierId, "payment.post", "payment", "pay-2");
  await insert("2001-03-02T04:00:00Z", cashierId, "report.export", "report", "collections");
  await insert("2001-03-02T05:00:00Z", cashierId, "something.custom", "thing", null);
  await insert("2001-03-02T06:00:00Z", null, "billing.generate", "billing_cycle", "cyc-1");
  await insert("2001-04-01T00:00:00Z", adminId, "plan.create", "plan", "plan-1"); // outside the March range

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_activity_at, expires_at)
     VALUES ($1, 'aud-test-hash-1', '2001-03-02T01:00:00Z', '2001-03-02T01:00:00Z', '2001-03-02T13:00:00Z'),
            ($1, 'aud-test-hash-2', '2001-05-02T01:00:00Z', '2001-05-02T01:00:00Z', '2001-05-02T13:00:00Z')`,
    [cashierId],
  );

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("audit log", () => {
  it("lists newest first with the actor, and pages", async () => {
    const all = await list({ from: "2001-01-01", to: "2001-12-31", pageSize: 3 });
    expect(all.total).toBe(7);
    expect(all.items.map((i) => i.action)).toEqual(["plan.create", "billing.generate", "something.custom"]);
    expect(all.items[1]!.actor).toBeNull();
    expect(all.items[0]!.actor).toMatchObject({ id: adminId, username: "aud_admin" });
    const page3 = await list({ from: "2001-01-01", to: "2001-12-31", pageSize: 3, page: 3 });
    expect(page3.items.map((i) => i.action)).toEqual(["payment.post"]);
  });

  it("filters by Manila calendar day, not UTC", async () => {
    const march2 = await list({ from: "2001-03-02", to: "2001-03-02" });
    expect(march2.items.map((i) => i.action)).toContain("invoice.void");
    const march1 = await list({ from: "2001-03-01", to: "2001-03-01" });
    expect(march1.items.map((i) => i.action)).toEqual(["payment.post"]);
  });

  it("filters by user, area of work, action and entity, keeping reason and old/new values", async () => {
    expect((await list({ actorUserId: cashierId })).total).toBe(3);
    expect((await list({ category: "payments" })).items.map((i) => i.entityId).toSorted((a, b) => a!.localeCompare(b!))).toEqual(["pay-1", "pay-2"]);
    expect((await list({ category: "other" })).items.map((i) => i.action)).toEqual(["something.custom"]);
    const voided = await list({ entityType: "invoice", entityId: "inv-1" });
    expect(voided.items).toEqual([
      expect.objectContaining({ action: "invoice.void", reason: "Billed in error", oldValues: { status: "unpaid" }, newValues: { status: "invoice.void" } }),
    ]);
    expect((await list({ action: "payment.post", actorUserId: adminId })).total).toBe(1);
  });
});

describe("user activity", () => {
  it("counts sign-ins and actions per user by area, lists idle active users and unattributed actions", async () => {
    const r = await getUserActivity(db, userActivityQuerySchema.parse({ from: "2001-03-01", to: "2001-03-31" }));
    const cashier = r.users.find((u) => u.userId === cashierId)!;
    expect(cashier).toMatchObject({ loginCount: 1, actionCount: 3, roles: "Cashier" });
    expect(cashier.byCategory).toMatchObject({ payments: 1, exports: 1, other: 1, billing: 0 });
    const admin = r.users.find((u) => u.userId === adminId)!;
    expect(admin).toMatchObject({ loginCount: 0, actionCount: 2 });
    expect(admin.byCategory).toMatchObject({ payments: 1, billing: 1, services: 0 });
    expect(r.users.find((u) => u.userId === null)).toMatchObject({ actionCount: 1, byCategory: expect.objectContaining({ billing: 1 }) });
    expect(r.users.find((u) => u.username === "aud_viewer")).toMatchObject({ actionCount: 0, loginCount: 0 });
    expect(r.actions[0]).toEqual({ action: "payment.post", category: "payments", count: 2, userCount: 2 });
    expect(r.totals).toMatchObject({ loginCount: 1, actionCount: 6 });
  });
});

describe("audit routes", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };

  it("lets audit.view read the log and activity, refuses others, and audits the export", async () => {
    for (const username of ["aud_auditor", "aud_admin"]) {
      const headers = await bearer(username);
      const res = await app.inject({ method: "GET", url: "/audit-logs?from=2001-03-01&to=2001-03-31", headers });
      expect(res.statusCode, username).toBe(200);
      expect(res.json().total).toBe(6);
      expect((await app.inject({ method: "GET", url: "/audit-logs/filter-options", headers })).json().actions).toContain("invoice.void");
    }
    for (const username of ["aud_cashier", "aud_viewer"]) {
      const headers = await bearer(username);
      expect((await app.inject({ method: "GET", url: "/audit-logs", headers })).statusCode, username).toBe(403);
      expect((await app.inject({ method: "GET", url: "/reports/user-activity?from=2001-03-01&to=2001-03-31", headers })).statusCode).toBe(403);
    }

    const auditor = await bearer("aud_auditor");
    const xlsx = await app.inject({ method: "GET", url: "/reports/user-activity/export?from=2001-03-01&to=2001-03-31&format=xlsx", headers: auditor });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="user-activity-2001-03-01_to_2001-03-31.xlsx"');
    const exports = await db.select().from(auditLogs).where(eq(auditLogs.entityId, "user-activity"));
    expect(exports).toEqual([expect.objectContaining({ action: "report.export", newValues: expect.objectContaining({ format: "xlsx" }) })]);
  });

  it("validates filters, and offers no way to change audit rows", async () => {
    const headers = await bearer("aud_auditor");
    for (const url of ["/audit-logs?category=secrets", "/audit-logs?from=2001-03-31&to=2001-03-01", "/audit-logs?actorUserId=me", "/reports/user-activity?from=2001-03-01"]) {
      expect((await app.inject({ method: "GET", url, headers })).statusCode, url).toBe(400);
    }
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/audit-logs", headers })).statusCode, method).toBe(404);
    }
  });
});
