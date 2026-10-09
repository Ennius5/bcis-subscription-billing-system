import { sql } from "drizzle-orm";
import {
  agingQuerySchema,
  planCreateSchema,
  receivableListQuerySchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
  suspensionCandidateQuerySchema,
} from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbToday } from "../db/query_helpers";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { getAgingReport, listReceivables, listSuspensionCandidates } from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let today: string;
let areaNorth: string;
let areaSouth: string;
let collectorOne: string;
let collectorTwo: string;
let alpha: { subscriberId: string; accountNumber: string };
let beta: { subscriberId: string; accountNumber: string };
/** Alpha's internet service (collector one), with arrears. */
let alphaInternet: string;
/** Alpha's cable service, collector two by override, nothing past due. */
let alphaCable: string;
/** Beta's terminated internet service (collector two), still owing 90+ days. */
let betaInternet: string;
let invoiceNo = 0;

/** A date `days` from today (negative = in the past), as "YYYY-MM-DD". */
function day(days: number): string {
  const [y = 0, m = 1, d = 1] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function insertInvoice(
  serviceId: string,
  subscriberId: string,
  dueInDays: number,
  options: { total?: number; paid?: number; status?: string } = {},
): Promise<void> {
  invoiceNo += 1;
  // Periods are synthetic (one per invoice) so no two invoices of a service share a month.
  const year = 2000 + Math.floor((invoiceNo - 1) / 12);
  const month = String(((invoiceNo - 1) % 12) + 1).padStart(2, "0");
  const periodStart = `${year}-${month}-01`;
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id)
     VALUES ($1::date, ($1::date + interval '1 month' - interval '1 day')::date, $2)
     ON CONFLICT (period_start) DO UPDATE SET period_start = EXCLUDED.period_start RETURNING id`,
    [periodStart, actorId],
  );
  const status = options.status ?? "unpaid";
  const isDraft = status === "draft";
  await pool.query(
    `INSERT INTO invoices (invoice_number, billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, status, total_centavos, paid_centavos, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, $6, $6, $7, $8, $9, $10,
       CASE WHEN $11 THEN NULL ELSE now() END, CASE WHEN $11 THEN NULL ELSE $10::uuid END)`,
    [
      isDraft ? null : `INV-R${String(invoiceNo).padStart(5, "0")}`,
      cycle.rows[0]!.id,
      subscriberId,
      serviceId,
      periodStart,
      day(dueInDays),
      status,
      options.total ?? 99_900,
      options.paid ?? 0,
      actorId,
      isDraft,
    ],
  );
}

async function setSettings(grace: number, threshold: number) {
  await pool.query(
    `UPDATE application_settings SET value = CASE key WHEN 'grace_period_days' THEN $1 ELSE $2 END
     WHERE key IN ('grace_period_days', 'suspension_threshold_invoices')`,
    [String(grace), String(threshold)],
  );
}

const list = (query: Record<string, unknown> = {}) => listReceivables(db, receivableListQuerySchema.parse(query));
const services = (page: { items: { serviceAccountId: string }[] }) => page.items.map((r) => r.serviceAccountId);

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, collectors, collection_areas, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "receivables_actor", "Passw0rd!test", "administrator");
  today = await dbToday(db);

  const insert = async (q: string, values: unknown[]) => (await pool.query<{ id: string }>(q, values)).rows[0]!.id;
  areaNorth = await insert(`INSERT INTO collection_areas (code, name) VALUES ('AR-N', 'North') RETURNING id`, []);
  areaSouth = await insert(`INSERT INTO collection_areas (code, name) VALUES ('AR-S', 'South') RETURNING id`, []);
  collectorOne = await insert(`INSERT INTO collectors (code, full_name) VALUES ('AR-C1', 'Collector One') RETURNING id`, []);
  collectorTwo = await insert(`INSERT INTO collectors (code, full_name) VALUES ('AR-C2', 'Collector Two') RETURNING id`, []);

  const internet = (
    await createPlan(db, actorId, planCreateSchema.parse({ code: "ar-inet", name: "Fiber 50", serviceType: "internet", priceCentavos: 99_900 }))
  ).id;
  const cable = (
    await createPlan(db, actorId, planCreateSchema.parse({ code: "ar-cable", name: "Basic Cable", serviceType: "cable", priceCentavos: 50_000 }))
  ).id;

  const address = { line1: "Purok 4", barangay: "Poblacion", city: "Valencia" };
  const makeSubscriber = async (fullName: string, areaId: string, collectorId: string) => {
    const s = await createSubscriber(db, actorId, subscriberCreateSchema.parse({ fullName, billingDay: 5, address }));
    await pool.query(`UPDATE subscribers SET collection_area_id = $2, assigned_collector_id = $3 WHERE id = $1`, [
      s.id,
      areaId,
      collectorId,
    ]);
    return { subscriberId: s.id, accountNumber: s.accountNumber, addressId: s.addresses[0]!.id };
  };
  const makeService = async (subscriberId: string, addressId: string, planId: string, status: string) => {
    const id = (await createServiceAccount(db, actorId, subscriberId, serviceAccountCreateSchema.parse({ planId, installationAddressId: addressId }))).id;
    await pool.query(
      `UPDATE service_accounts SET status = $2, activation_date = '2025-01-01', billing_start_date = '2025-01-01' WHERE id = $1`,
      [id, status],
    );
    return id;
  };

  const a = await makeSubscriber("Alpha Receivable", areaNorth, collectorOne);
  const b = await makeSubscriber("Beta Receivable", areaSouth, collectorTwo);
  alpha = a;
  beta = b;
  alphaInternet = await makeService(a.subscriberId, a.addressId, internet, "active");
  alphaCable = await makeService(a.subscriberId, a.addressId, cable, "active");
  await pool.query(`UPDATE service_accounts SET assigned_collector_id = $2 WHERE id = $1`, [alphaCable, collectorTwo]);
  betaInternet = await makeService(b.subscriberId, b.addressId, internet, "terminated");

  // Alpha internet: 40 days past due (open), 10 days past due (half paid), due in 5 days, plus a draft.
  await insertInvoice(alphaInternet, a.subscriberId, -40);
  await insertInvoice(alphaInternet, a.subscriberId, -10, { paid: 50_000, status: "partially_paid" });
  await insertInvoice(alphaInternet, a.subscriberId, 5);
  await insertInvoice(alphaInternet, a.subscriberId, -70, { status: "draft" });
  // Alpha cable: an old invoice fully paid, and one due in 3 days.
  await insertInvoice(alphaCable, a.subscriberId, -70, { total: 50_000, paid: 50_000, status: "paid" });
  await insertInvoice(alphaCable, a.subscriberId, 3, { total: 50_000 });
  // Beta: terminated with one invoice 100 days past due.
  await insertInvoice(betaInternet, b.subscriberId, -100, { total: 50_000 });

  // Alpha paid 3 days ago and 100.00 of it is still unallocated credit.
  await pool.query(
    `INSERT INTO payments (receipt_number, subscriber_id, method, amount_centavos, payment_date, received_by_user_id)
     VALUES ('RCPT-R00001', $1, 'cash', 10000, $2, $3)`,
    [a.subscriberId, day(-3), actorId],
  );
});

beforeEach(async () => {
  await setSettings(7, 1);
});

afterAll(async () => {
  await setSettings(7, 1);
  await pool.end();
});

describe("outstanding and overdue lists", () => {
  it("lists every open balance per service account with arrears split out", async () => {
    const page = await list();
    expect(page.asOf).toBe(today);
    expect(page.total).toBe(3);
    const row = page.items.find((r) => r.serviceAccountId === alphaInternet)!;
    expect(row).toMatchObject({
      accountNumber: alpha.accountNumber,
      planName: "Fiber 50",
      serviceType: "internet",
      areaName: "North",
      collectorCode: "AR-C1",
      openInvoiceCount: 3,
      monthsUnpaid: 2,
      oldestDueDate: day(-40),
      daysPastDue: 40,
      bucket: "days_31_60",
      lastPaymentDate: day(-3),
      currentCentavos: 99_900,
      arrearsCentavos: 99_900 + 49_900,
      totalOpenCentavos: 99_900 + 49_900 + 99_900,
    });
    expect(page.totalOpenCentavos).toBe(249_700 + 50_000 + 50_000);
    expect(page.totalArrearsCentavos).toBe(149_800 + 50_000);
  });

  it("keeps terminated accounts that still owe, and leaves out paid and draft invoices", async () => {
    const page = await list();
    const terminated = page.items.find((r) => r.serviceAccountId === betaInternet)!;
    expect(terminated).toMatchObject({ serviceStatus: "terminated", bucket: "days_90_plus", totalOpenCentavos: 50_000 });
    const cableRow = page.items.find((r) => r.serviceAccountId === alphaCable)!;
    expect(cableRow).toMatchObject({ openInvoiceCount: 1, monthsUnpaid: 0, bucket: "current", daysPastDue: 0 });
  });

  it("shows only accounts with arrears in the overdue view", async () => {
    const page = await list({ view: "overdue" });
    expect(services(page).toSorted()).toEqual([alphaInternet, betaInternet].toSorted());
  });

  it("filters by effective collector, area, service type, bucket and search", async () => {
    // The cable service's own collector wins over Alpha's.
    expect(services(await list({ collectorId: collectorTwo })).toSorted()).toEqual([alphaCable, betaInternet].toSorted());
    expect(services(await list({ areaId: areaNorth })).toSorted()).toEqual([alphaInternet, alphaCable].toSorted());
    expect(services(await list({ serviceType: "cable" }))).toEqual([alphaCable]);
    expect(services(await list({ bucket: "days_90_plus" }))).toEqual([betaInternet]);
    expect(services(await list({ search: beta.accountNumber }))).toEqual([betaInternet]);
  });

  it("sorts and pages", async () => {
    expect(services(await list({ sort: "oldest" }))).toEqual([betaInternet, alphaInternet, alphaCable]);
    expect(services(await list({ sort: "arrears" }))).toEqual([alphaInternet, betaInternet, alphaCable]);
    const second = await list({ sort: "oldest", page: 2, pageSize: 1 });
    expect(services(second)).toEqual([alphaInternet]);
    expect(second.total).toBe(3);
  });
});

describe("aging", () => {
  it("puts each open invoice in its bucket and shows credit separately", async () => {
    const report = await getAgingReport(db, agingQuerySchema.parse({}));
    const bucket = (name: string) => report.buckets.find((b) => b.bucket === name)!;
    expect(bucket("current")).toEqual({ bucket: "current", amountCentavos: 99_900 + 50_000, invoiceCount: 2, accountCount: 1 });
    expect(bucket("days_1_30")).toMatchObject({ amountCentavos: 49_900, invoiceCount: 1, accountCount: 0 });
    expect(bucket("days_31_60")).toMatchObject({ amountCentavos: 99_900, invoiceCount: 1, accountCount: 1 });
    expect(bucket("days_61_90")).toMatchObject({ amountCentavos: 0, invoiceCount: 0, accountCount: 0 });
    expect(bucket("days_90_plus")).toMatchObject({ amountCentavos: 50_000, invoiceCount: 1, accountCount: 1 });
    expect(report).toMatchObject({
      totalOpenCentavos: 349_700,
      overdueCentavos: 199_800,
      overdueAccountCount: 2,
      overdueSubscriberCount: 2,
      unappliedCreditCentavos: 10_000,
      netReceivableCentavos: 339_700,
    });
  });

  it("counts credit only for subscribers in the selection", async () => {
    const south = await getAgingReport(db, agingQuerySchema.parse({ areaId: areaSouth }));
    expect(south).toMatchObject({ totalOpenCentavos: 50_000, unappliedCreditCentavos: 0 });
    const north = await getAgingReport(db, agingQuerySchema.parse({ areaId: areaNorth }));
    expect(north.unappliedCreditCentavos).toBe(10_000);
  });
});

describe("suspension candidates", () => {
  const candidates = async (query: Record<string, unknown> = {}) =>
    listSuspensionCandidates(db, suspensionCandidateQuerySchema.parse(query));

  it("lists active accounts with enough invoices past the grace period, never terminated ones", async () => {
    const result = await candidates();
    expect(result.settings).toEqual({ gracePeriodDays: 7, suspensionThresholdInvoices: 1 });
    expect(result.items.map((c) => c.serviceAccountId)).toEqual([alphaInternet]);
    expect(result.items[0]).toMatchObject({ pastGraceCount: 2, pastGraceCentavos: 149_800 });
  });

  it("follows the configured grace period and threshold", async () => {
    await setSettings(7, 3);
    expect((await candidates()).items).toEqual([]);
    // With 15 days of grace only the 40-day-old invoice counts.
    await setSettings(15, 1);
    expect((await candidates()).items[0]).toMatchObject({ pastGraceCount: 1, pastGraceCentavos: 99_900 });
    await setSettings(45, 1);
    expect((await candidates()).items).toEqual([]);
  });

  it("applies the filters", async () => {
    expect((await candidates({ collectorId: collectorTwo })).items).toEqual([]);
    expect((await candidates({ areaId: areaNorth })).items).toHaveLength(1);
  });
});
