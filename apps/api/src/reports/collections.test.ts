import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { addDays, collectionsReportQuerySchema, paymentCreateSchema, subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { dbToday } from "../db/query_helpers";
import { auditLogs } from "../db/schema";
import { postPayment, reversePayment } from "../payments/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { getCollectionsReport } from "./collections";

// Payments are posted through the real payment service (no invoices, so they become credit);
// dates are relative to the database's today, because a reversal is always dated today.

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let today: string;
let tenDaysAgo: string;

const report = (from: string, to: string, groupBy: "day" | "week" | "month" | "year" = "day") =>
  getCollectionsReport(db, collectionsReportQuerySchema.parse({ from, to, groupBy }));

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  const actorId = await createTestUser(db, "rpt_admin", PASSWORD, "administrator");
  await createTestUser(db, "rpt_cashier", PASSWORD, "cashier");
  await createTestUser(db, "rpt_viewer", PASSWORD, "viewer");
  await createTestUser(db, "rpt_auditor", PASSWORD, "auditor");

  today = await dbToday(db);
  tenDaysAgo = addDays(today, -10);
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName: "Report Demo",
      billingDay: 5,
      address: { line1: "Purok 1", barangay: "Poblacion", city: "Valencia" },
    }),
  );
  const pay = (method: string, amountCentavos: number, paymentDate: string, referenceNumber?: string) =>
    postPayment(
      db,
      actorId,
      paymentCreateSchema.parse({ subscriberId: subscriber.id, method, amountCentavos, paymentDate, referenceNumber }),
    );

  const reversed = await pay("cash", 50_000, tenDaysAgo);
  await pay("bank_transfer", 100_000, tenDaysAgo, "BDO-1001");
  await pay("cheque", 30_000, addDays(today, -3), "CHK-2001");
  await pay("cash", 20_000, today);
  // Reversed today: subtracted today, while the original stays in its own day.
  await reversePayment(db, actorId, reversed.id, { reason: "Counterfeit bill" });

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("collections report", () => {
  it("counts payments on their date and subtracts a reversal on the day it was made", async () => {
    const r = await report(tenDaysAgo, today);
    expect(r.periods).toHaveLength(11);
    expect(r.totals).toEqual({
      paymentCount: 4,
      collectedCentavos: 200_000,
      reversalCount: 1,
      reversedCentavos: 50_000,
      netCentavos: 150_000,
    });

    const first = r.periods[0]!;
    expect(first).toMatchObject({ start: tenDaysAgo, paymentCount: 2, collectedCentavos: 150_000, reversedCentavos: 0, netCentavos: 150_000 });
    expect(first.netByMethod).toEqual({ cash: 50_000, gcash: 0, bank_transfer: 100_000, cheque: 0, other: 0 });

    const last = r.periods.at(-1)!;
    expect(last).toMatchObject({ start: today, collectedCentavos: 20_000, reversedCentavos: 50_000, netCentavos: -30_000 });
    expect(last.netByMethod.cash).toBe(-30_000);

    expect(r.methods.map((m) => m.method)).toEqual(["cash", "gcash", "bank_transfer", "cheque", "other"]);
    expect(r.methods[0]).toEqual({
      method: "cash",
      paymentCount: 2,
      collectedCentavos: 70_000,
      reversalCount: 1,
      reversedCentavos: 50_000,
      netCentavos: 20_000,
    });
    expect(r.methods.find((m) => m.method === "gcash")!.paymentCount).toBe(0);
  });

  it("keeps past periods stable: a range ending yesterday does not see today's reversal", async () => {
    const r = await report(tenDaysAgo, addDays(today, -1));
    expect(r.totals).toMatchObject({ collectedCentavos: 180_000, reversedCentavos: 0, netCentavos: 180_000 });
  });

  it("gives the same totals whatever the grouping, with the period edges clipped", async () => {
    const daily = await report(tenDaysAgo, today, "day");
    for (const groupBy of ["week", "month", "year"] as const) {
      const r = await report(tenDaysAgo, today, groupBy);
      expect(r.totals, groupBy).toEqual(daily.totals);
      expect(r.periods[0]!.start, groupBy).toBe(tenDaysAgo);
      expect(r.periods.at(-1)!.end, groupBy).toBe(today);
      expect(r.periods.reduce((t, p) => t + p.netCentavos, 0), groupBy).toBe(150_000);
    }
  });

  it("returns zero rows for a range with no payments", async () => {
    const r = await report("2001-01-01", "2001-01-03");
    expect(r.periods.map((p) => p.netCentavos)).toEqual([0, 0, 0]);
    expect(r.totals.paymentCount).toBe(0);
  });
});

describe("collections report routes", () => {
  const bearer = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    return { authorization: `Bearer ${res.json().token as string}` };
  };
  const url = () => `/reports/collections?from=${tenDaysAgo}&to=${today}&groupBy=week`;
  const exportUrl = (format: string) => `/reports/collections/export?from=${tenDaysAgo}&to=${today}&format=${format}`;

  it("needs report.view to read and report.export to export", async () => {
    expect((await app.inject({ method: "GET", url: url() })).statusCode).toBe(401);
    const cashier = await bearer("rpt_cashier");
    expect((await app.inject({ method: "GET", url: url(), headers: cashier })).statusCode).toBe(403);

    const viewer = await bearer("rpt_viewer");
    const read = await app.inject({ method: "GET", url: url(), headers: viewer });
    expect(read.statusCode).toBe(200);
    expect(read.json().totals.netCentavos).toBe(150_000);
    expect((await app.inject({ method: "GET", url: exportUrl("pdf"), headers: viewer })).statusCode).toBe(403);
  });

  it("validates the range", async () => {
    const auditor = await bearer("rpt_auditor");
    for (const bad of [
      "/reports/collections?from=2026-10-31&to=2026-10-01",
      "/reports/collections?from=2020-01-01&to=2026-01-01&groupBy=day",
      "/reports/collections?from=2026-10-01",
      "/reports/collections/export?from=2026-10-01&to=2026-10-31",
    ]) {
      const res = await app.inject({ method: "GET", url: bad, headers: auditor });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it("exports PDF and XLSX and audits each export", async () => {
    const auditor = await bearer("rpt_auditor");
    for (const format of ["pdf", "xlsx"]) {
      const res = await app.inject({ method: "GET", url: exportUrl(format), headers: auditor });
      expect(res.statusCode, format).toBe(200);
      expect(res.headers["content-disposition"]).toBe(`attachment; filename="collections-${tenDaysAgo}_to_${today}.${format}"`);
    }
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "report.export"), eq(auditLogs.entityId, "collections")));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      entityId: "collections",
      newValues: { filters: { from: tenDaysAgo, to: today, groupBy: "day" }, rows: 11 + 5 },
    });
  });
});
