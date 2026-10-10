import { and, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import {
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { dbToday } from "../db/query_helpers";
import { auditLogs } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let adminId: string;
let technicianId: string;
let serviceId: string;
let invoiceId: string;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  adminId = await createTestUser(db, "recv_admin", PASSWORD, "administrator");
  await createTestUser(db, "recv_owner", PASSWORD, "owner");
  await createTestUser(db, "recv_cashier", PASSWORD, "cashier");
  await createTestUser(db, "recv_viewer", PASSWORD, "viewer");
  await createTestUser(db, "recv_auditor", PASSWORD, "auditor");
  technicianId = await createTestUser(db, "recv_tech", PASSWORD, "technician");

  const plan = await createPlan(
    db,
    adminId,
    planCreateSchema.parse({ code: "recv-rt", name: "Internet 25", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    adminId,
    subscriberCreateSchema.parse({
      fullName: "Route Receivable",
      billingDay: 5,
      address: { line1: "Purok 6", barangay: "Poblacion", city: "Manolo Fortich" },
    }),
  );
  serviceId = (
    await createServiceAccount(
      db,
      adminId,
      subscriber.id,
      serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
    )
  ).id;
  await changeServiceStatus(
    db,
    adminId,
    serviceId,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: "2025-01-01" }),
  );

  // One finalized invoice, 30 days past due.
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2001-01-01', '2001-01-31', $1) RETURNING id`,
    [adminId],
  );
  const due = await pool.query<{ due: string }>(`SELECT (CURRENT_DATE - 30)::text AS due`);
  const invoice = await pool.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, status, total_centavos, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ('INV-RT0001', $1, $2, $3, '2001-01-01', '2001-01-31', $4, $4, 'unpaid', 99900, $5, now(), $5) RETURNING id`,
    [cycle.rows[0]!.id, subscriber.id, serviceId, due.rows[0]!.due, adminId],
  );
  invoiceId = invoice.rows[0]!.id;

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await pool.query(`UPDATE application_settings SET value = '7' WHERE key = 'grace_period_days'`);
  await app.close();
  await pool.end();
});

const views = [
  { method: "GET", url: "/receivables" },
  { method: "GET", url: "/receivables/aging" },
] as const;

const controls = () =>
  [
    { method: "GET", url: "/receivables/suspension-candidates" },
    { method: "GET", url: "/reconnections" },
    { method: "GET", url: `/reconnections/${NIL_ID}` },
    { method: "GET", url: "/technicians" },
    { method: "POST", url: `/service-accounts/${NIL_ID}/suspend`, payload: { reason: "Testing", approvedBy: "Owner" } },
    { method: "POST", url: `/service-accounts/${NIL_ID}/reconnections`, payload: {} },
    { method: "POST", url: `/reconnections/${NIL_ID}/assign`, payload: { technicianUserId: NIL_ID } },
    { method: "POST", url: `/reconnections/${NIL_ID}/complete`, payload: {} },
    { method: "POST", url: `/reconnections/${NIL_ID}/cancel`, payload: { reason: "Testing" } },
  ] as const;

const settings = [
  { method: "GET", url: "/settings/receivables" },
  { method: "PATCH", url: "/settings/receivables", payload: { gracePeriodDays: 10 } },
] as const;

describe("receivable routes: authorization", () => {
  it("rejects requests with no token", async () => {
    for (const call of [...views, ...controls(), ...settings]) {
      expect((await app.inject(call)).statusCode, call.url).toBe(401);
    }
  });

  it("lets viewers and cashiers read receivables, but not suspend, reconnect or change settings", async () => {
    for (const username of ["recv_viewer", "recv_cashier"]) {
      const headers = bearer(await tokenFor(username));
      for (const call of views) expect((await app.inject({ ...call, headers })).statusCode, `${username} ${call.url}`).toBe(200);
      for (const call of [...controls(), ...settings]) {
        expect((await app.inject({ ...call, headers })).statusCode, `${username} ${call.url}`).toBe(403);
      }
    }
  });

  it("lets a technician do suspension work but not read receivables or settings", async () => {
    const headers = bearer(await tokenFor("recv_tech"));
    for (const call of [...views, ...settings]) expect((await app.inject({ ...call, headers })).statusCode, call.url).toBe(403);
    const candidates = await app.inject({ ...controls()[0], headers });
    expect(candidates.statusCode).toBe(200);
  });

  it("serves the filter options to anyone with receivable.view or suspension.manage", async () => {
    for (const username of ["recv_viewer", "recv_cashier", "recv_tech"]) {
      const res = await app.inject({ method: "GET", url: "/receivables/filter-options", headers: bearer(await tokenFor(username)) });
      expect(res.statusCode, username).toBe(200);
      expect(res.json().plans).toEqual([expect.objectContaining({ code: "RECV-RT", serviceType: "internet", isActive: true })]);
    }
    const noToken = await app.inject({ method: "GET", url: "/receivables/filter-options" });
    expect(noToken.statusCode).toBe(401);
  });

  it("keeps settings to the owner: an administrator is refused", async () => {
    const headers = bearer(await tokenFor("recv_admin"));
    for (const call of settings) expect((await app.inject({ ...call, headers })).statusCode, call.url).toBe(403);
  });

  it("writes no audit rows for refused requests", async () => {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} LIKE 'settings.%' OR ${auditLogs.action} LIKE 'service_account.suspend%' OR ${auditLogs.action} LIKE 'service_account.reconnect%'`);
    expect(rows).toEqual([]);
  });
});

describe("receivable routes: lists", () => {
  it("returns the overdue list, aging and candidates", async () => {
    const admin = bearer(await tokenFor("recv_admin"));
    const overdue = await app.inject({ method: "GET", url: "/receivables?view=overdue&sort=arrears", headers: admin });
    expect(overdue.statusCode).toBe(200);
    expect(overdue.json()).toMatchObject({ total: 1, totalArrearsCentavos: 99_900, asOf: await dbToday(db) });

    const aging = await app.inject({ method: "GET", url: "/receivables/aging", headers: admin });
    expect(aging.json().buckets).toContainEqual(
      expect.objectContaining({ bucket: "days_1_30", amountCentavos: 99_900, accountCount: 1 }),
    );

    const candidates = await app.inject({ method: "GET", url: "/receivables/suspension-candidates", headers: admin });
    expect(candidates.json().items).toEqual([expect.objectContaining({ serviceAccountId: serviceId, pastGraceCount: 1 })]);
  });

  it("validates list queries", async () => {
    const admin = bearer(await tokenFor("recv_admin"));
    for (const url of ["/receivables?view=late", "/receivables?bucket=days_2", "/receivables/aging?serviceType=fiber", "/reconnections?status=done"]) {
      const res = await app.inject({ method: "GET", url, headers: admin });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("VALIDATION");
    }
  });
});

describe("receivable routes: aging export", () => {
  const exportUrl = (format: string) => `/receivables/aging/export?format=${format}&serviceType=internet`;

  it("needs report.export on top of receivable.view, and audits nothing it refuses", async () => {
    expect((await app.inject({ method: "GET", url: exportUrl("pdf") })).statusCode).toBe(401);
    for (const username of ["recv_viewer", "recv_cashier", "recv_tech"]) {
      const res = await app.inject({ method: "GET", url: exportUrl("pdf"), headers: bearer(await tokenFor(username)) });
      expect(res.statusCode, username).toBe(403);
    }
    const auditor = bearer(await tokenFor("recv_auditor"));
    for (const url of ["/receivables/aging/export", "/receivables/aging/export?format=csv", "/receivables/aging/export?format=pdf&serviceType=fiber"]) {
      const res = await app.inject({ method: "GET", url, headers: auditor });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("VALIDATION");
    }
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "report.export"))).toEqual([]);
  });

  it("sends a PDF and an XLSX of the aging figures and audits each export", async () => {
    const today = await dbToday(db);
    const auditor = bearer(await tokenFor("recv_auditor"));

    const pdf = await app.inject({ method: "GET", url: exportUrl("pdf"), headers: auditor });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe(`attachment; filename="ar-aging-${today}.pdf"`);
    expect(pdf.headers["cache-control"]).toBe("no-store");
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const xlsx = await app.inject({ method: "GET", url: exportUrl("xlsx"), headers: bearer(await tokenFor("recv_admin")) });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Report")!;
    const cells = sheet.getSheetValues().flatMap((row) => (Array.isArray(row) ? row : []));
    expect(cells).toContain("Accounts Receivable Aging");
    expect(cells).toContain(`As of ${today}`);
    expect(cells).toContain("Service type: Internet");
    // The 1-30 bucket row: label, 1 invoice, 1 account, P999.00 as a number formatted in pesos.
    const bucketRow = sheet.getRows(1, sheet.rowCount)!.find((r) => r.getCell(1).value === "1–30 days")!;
    expect(bucketRow.getCell(4).value).toBe(999);
    expect(bucketRow.getCell(4).numFmt).toContain("₱");

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "report.export")).orderBy(auditLogs.occurredAt);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      entityType: "report",
      entityId: "ar-aging",
      newValues: { format: "pdf", fileName: `ar-aging-${today}.pdf`, filters: { serviceType: "internet" }, rows: 5 },
    });
    expect(audits[1]!.newValues).toMatchObject({ format: "xlsx", fileName: `ar-aging-${today}.xlsx` });
  });
});

describe("receivable routes: settings", () => {
  it("lets the owner read and change the grace period, auditing only real changes", async () => {
    const headers = bearer(await tokenFor("recv_owner"));
    const current = await app.inject({ method: "GET", url: "/settings/receivables", headers });
    expect(current.json()).toEqual({ gracePeriodDays: 7, suspensionThresholdInvoices: 1 });

    const bad = await app.inject({ method: "PATCH", url: "/settings/receivables", headers, payload: { gracePeriodDays: -1 } });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: "PATCH", url: "/settings/receivables", headers, payload: { reason: "Nothing" } });
    expect(empty.statusCode).toBe(400);

    const changed = await app.inject({
      method: "PATCH",
      url: "/settings/receivables",
      headers,
      payload: { gracePeriodDays: 10, suspensionThresholdInvoices: 1, reason: "New policy" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ gracePeriodDays: 10, suspensionThresholdInvoices: 1 });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "settings.update"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: "New policy", oldValues: { gracePeriodDays: 7 }, newValues: { gracePeriodDays: 10 } });

    // Same value again: no change, no audit row.
    await app.inject({ method: "PATCH", url: "/settings/receivables", headers, payload: { gracePeriodDays: 10 } });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "settings.update"))).toHaveLength(1);

    await app.inject({ method: "PATCH", url: "/settings/receivables", headers, payload: { gracePeriodDays: 7 } });
  });
});

describe("receivable routes: suspension and reconnection by a technician", () => {
  it("suspends, refuses reconnection until paid, then requests, assigns and completes", async () => {
    const headers = bearer(await tokenFor("recv_tech"));

    const missing = await app.inject({ method: "POST", url: `/service-accounts/${serviceId}/suspend`, headers, payload: { reason: "Unpaid" } });
    expect(missing.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url: `/service-accounts/${NIL_ID}/suspend`,
      headers,
      payload: { reason: "Unpaid", approvedBy: "Owner" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("NOT_FOUND");

    const suspended = await app.inject({
      method: "POST",
      url: `/service-accounts/${serviceId}/suspend`,
      headers,
      payload: { reason: "One month unpaid", approvedBy: "Owner", notes: "Phoned twice" },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe("suspended");
    const again = await app.inject({
      method: "POST",
      url: `/service-accounts/${serviceId}/suspend`,
      headers,
      payload: { reason: "Again", approvedBy: "Owner" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("NOT_ACTIVE");

    const early = await app.inject({ method: "POST", url: `/service-accounts/${serviceId}/reconnections`, headers, payload: {} });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("PAYMENT_REQUIRED");

    await pool.query(`UPDATE invoices SET paid_centavos = total_centavos, status = 'paid' WHERE id = $1`, [invoiceId]);
    const requested = await app.inject({ method: "POST", url: `/service-accounts/${serviceId}/reconnections`, headers, payload: {} });
    expect(requested.statusCode).toBe(201);
    const reconnectionId = requested.json().id as string;

    const open = await app.inject({ method: "GET", url: "/reconnections?status=open", headers });
    expect(open.json()).toMatchObject({ total: 1, items: [{ id: reconnectionId, serviceNumber: expect.stringMatching(/^SVC-/) }] });

    const technicians = await app.inject({ method: "GET", url: "/technicians", headers });
    expect(technicians.json()).toEqual([expect.objectContaining({ id: technicianId })]);

    const assigned = await app.inject({
      method: "POST",
      url: `/reconnections/${reconnectionId}/assign`,
      headers,
      payload: { technicianUserId: technicianId },
    });
    expect(assigned.json()).toMatchObject({ status: "assigned", technicianUserId: technicianId });

    const completed = await app.inject({ method: "POST", url: `/reconnections/${reconnectionId}/complete`, headers });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");

    const cancel = await app.inject({
      method: "POST",
      url: `/reconnections/${reconnectionId}/cancel`,
      headers,
      payload: { reason: "Too late" },
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error).toBe("INVALID_TRANSITION");

    const history = await app.inject({ method: "GET", url: `/service-accounts/${serviceId}/service-control`, headers });
    expect(history.json()).toMatchObject({
      suspensions: [{ approvedBy: "Owner", notes: "Phoned twice", pastDueInvoiceCount: 1 }],
      reconnections: [{ status: "completed" }],
    });

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, serviceId), sql`${auditLogs.action} <> 'service_account.create'`));
    expect(audit.map((a) => a.action).toSorted()).toEqual(
      [
        "service_account.reconnect",
        "service_account.reconnection_assign",
        "service_account.reconnection_request",
        "service_account.status_change",
        "service_account.suspend",
      ].toSorted(),
    );
  });
});
