import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { addMonths, periodBounds, periodOf, receivableListQuerySchema, RECEIVABLE_PAGE_SIZE_MAX } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { runIntegrityChecks } from "../backup/integrity";
import { getSubscriberBalance } from "../billing/ledger";
import { dbToday } from "../db/query_helpers";
import { subscribers } from "../db/schema";
import { seedDemoData } from "../db/seed-demo-data";
import { ProofStore } from "../payments/proof-storage";
import { getAgingReport, listReceivables } from "../receivables/service";
import { getBillingVsCollection } from "../reports/billing";
import { getCollectionsReport } from "../reports/collections";
import { getDashboard } from "../reports/dashboard";
import { getStatementOfAccount } from "../reports/statement";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

/*
 * QA check for spec section 14 ("AR aging totals reconcile to outstanding invoice balances",
 * "PDF/XLSX reports calculate correctly"): the full demo dataset (four months of billing,
 * payments, reversals, voids, adjustments, collections) is seeded, then every report that
 * shows money is checked against the invoices, payments and ledger underneath it, and the
 * exported spreadsheets against the reports.
 */

const PASSWORD = "Recon-Test-2026";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let workDir: string;
let token: string;
let today: string;

const one = async (query: ReturnType<typeof sql>) => Number((await db.execute<{ v: string }>(query)).rows[0]?.v ?? 0);

/** Open balance on posted invoices, straight from the invoice rows. */
const openFromInvoices = () =>
  one(sql`SELECT coalesce(sum(total_centavos + adjusted_centavos - paid_centavos), 0)::bigint AS v
          FROM invoices WHERE status NOT IN ('draft', 'void')`);
/** Payment money not applied to any invoice. */
const unappliedFromPayments = () =>
  one(sql`SELECT coalesce(sum(amount_centavos - allocated_centavos), 0)::bigint AS v FROM payments WHERE status = 'posted'`);
/** Every ledger entry ever posted: debits less credits. */
const ledgerTotal = () =>
  one(sql`SELECT coalesce(sum(debit_centavos - credit_centavos), 0)::bigint AS v FROM ledger_entries`);

async function xlsxRows(url: string): Promise<unknown[][]> {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  book.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(
    sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas, backup_history, integrity_checks CASCADE`,
  );
  await createTestUser(db, "demo_admin", PASSWORD, "administrator");
  await createTestUser(db, "demo_cashier", PASSWORD, "cashier");
  await createTestUser(db, "demo_supervisor", PASSWORD, "collection_supervisor");
  await createTestUser(db, "demo_technician", PASSWORD, "technician");

  workDir = await mkdtemp(path.join(os.tmpdir(), "bcis-reconcile-"));
  const proofDir = path.join(workDir, "proofs");
  await seedDemoData(db, new ProofStore(proofDir));
  today = await dbToday(db);

  app = buildApp(testConfig({ PROOF_STORAGE_DIR: proofDir }), { db, pool });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "demo_admin", password: PASSWORD } });
  token = login.json().token as string;
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(workDir, { recursive: true, force: true });
});

describe("Reconciliation on the full demo dataset (spec section 14)", () => {
  it("seeds a dataset with something in every aging bucket, so the checks below mean something", async () => {
    const aging = await getAgingReport(db, {});
    const pastDue = aging.buckets.filter((b) => b.bucket !== "current");
    expect(pastDue.every((b) => b.amountCentavos > 0)).toBe(true);
    expect(aging.overdueSubscriberCount).toBeGreaterThanOrEqual(10);
    expect(await one(sql`SELECT count(*)::int AS v FROM payments WHERE status = 'reversed'`)).toBeGreaterThan(0);
    expect(await one(sql`SELECT count(*)::int AS v FROM invoices WHERE status = 'void'`)).toBeGreaterThan(0);
  });

  it("AR aging totals equal the open invoice balances, and net of credit equal the ledgers", async () => {
    const aging = await getAgingReport(db, {});
    const open = await openFromInvoices();
    expect(aging.totalOpenCentavos).toBe(open);
    expect(aging.buckets.reduce((sum, b) => sum + b.amountCentavos, 0)).toBe(open);
    expect(aging.overdueCentavos).toBe(
      aging.buckets.filter((b) => b.bucket !== "current").reduce((sum, b) => sum + b.amountCentavos, 0),
    );
    expect(aging.unappliedCreditCentavos).toBe(await unappliedFromPayments());
    expect(aging.netReceivableCentavos).toBe(open - aging.unappliedCreditCentavos);
    expect(aging.netReceivableCentavos).toBe(await ledgerTotal());
  });

  it("every subscriber's ledger balance and Statement of Account agree with their invoices and payments", async () => {
    const all = await db.select({ id: subscribers.id }).from(subscribers);
    expect(all.length).toBe(50);
    let sum = 0;
    for (const { id } of all) {
      const balance = await getSubscriberBalance(db, id);
      const soa = await getStatementOfAccount(db, id, {});
      expect(soa.reconciles).toBe(true);
      expect(soa.ledger.closingBalanceCentavos).toBe(balance);
      expect(soa.openInvoicesCentavos - soa.unappliedCreditCentavos).toBe(balance);
      const openHere = await one(sql`SELECT coalesce(sum(total_centavos + adjusted_centavos - paid_centavos), 0)::bigint AS v
                                     FROM invoices WHERE subscriber_id = ${id} AND status NOT IN ('draft', 'void')`);
      expect(soa.openInvoicesCentavos).toBe(openHere);
      sum += balance;
    }
    expect(sum).toBe(await ledgerTotal());
  });

  it("the Outstanding and Overdue lists add up to the aging report", async () => {
    const aging = await getAgingReport(db, {});
    const outstanding = await listReceivables(db, receivableListQuerySchema.parse({ pageSize: RECEIVABLE_PAGE_SIZE_MAX }));
    expect(outstanding.totalOpenCentavos).toBe(aging.totalOpenCentavos);
    expect(outstanding.totalArrearsCentavos).toBe(aging.overdueCentavos);
    const overdue = await listReceivables(db, receivableListQuerySchema.parse({ view: "overdue", pageSize: RECEIVABLE_PAGE_SIZE_MAX }));
    expect(overdue.totalArrearsCentavos).toBe(aging.overdueCentavos);
    expect(overdue.items.every((r) => r.arrearsCentavos > 0)).toBe(true);
  });

  it("the dashboard's aging and this month's collections match the reports", async () => {
    const [dashboard, aging] = [await getDashboard(db), await getAgingReport(db, {})];
    for (const bucket of aging.buckets) {
      expect(dashboard.aging.find((b) => b.bucket === bucket.bucket)?.amountCentavos).toBe(bucket.amountCentavos);
    }
    const month = periodOf(today);
    const collections = await getCollectionsReport(db, { from: `${month}-01`, to: today, groupBy: "month" });
    expect(dashboard.paymentMethods.reduce((sum, m) => sum + m.netCentavos, 0)).toBe(collections.totals.netCentavos);
  });

  it("the Collections report equals the posted payments, by method and by month", async () => {
    const first = (await db.execute<{ v: string }>(sql`SELECT min(payment_date)::text AS v FROM payments`)).rows[0]!.v;
    const report = await getCollectionsReport(db, { from: first, to: today, groupBy: "month" });
    expect(report.totals.netCentavos).toBe(
      await one(sql`SELECT coalesce(sum(amount_centavos), 0)::bigint AS v FROM payments WHERE status = 'posted'`),
    );
    expect(report.totals.collectedCentavos - report.totals.reversedCentavos).toBe(report.totals.netCentavos);
    expect(report.methods.reduce((sum, m) => sum + m.netCentavos, 0)).toBe(report.totals.netCentavos);
    expect(report.periods.reduce((sum, p) => sum + p.netCentavos, 0)).toBe(report.totals.netCentavos);
    for (const method of report.methods) {
      expect(method.netCentavos).toBe(
        await one(sql`SELECT coalesce(sum(amount_centavos), 0)::bigint AS v FROM payments WHERE status = 'posted' AND method = ${method.method}`),
      );
    }
  });

  it("Billing vs Collection bills what the invoices say and collects what the Collections report says", async () => {
    const to = periodOf(today);
    const from = addMonths(to, -3);
    const report = await getBillingVsCollection(db, { from, to });
    for (const row of report.months) {
      const billed = await one(sql`SELECT coalesce(sum(total_centavos), 0)::bigint AS v FROM invoices
                                   WHERE status NOT IN ('draft', 'void') AND to_char(period_start, 'YYYY-MM') = ${row.month}`);
      expect(row.billedCentavos).toBe(billed);
      expect(row.netBilledCentavos).toBe(row.billedCentavos + row.adjustmentsCentavos);
      const { start, end } = periodBounds(row.month);
      const collected = await getCollectionsReport(db, { from: start, to: end < today ? end : today, groupBy: "month" });
      expect(row.collectedCentavos).toBe(collected.totals.netCentavos);
    }
  });

  it("exported XLSX files carry the same totals as the reports; PDFs are produced", async () => {
    const aging = await getAgingReport(db, {});
    const agingRows = await xlsxRows("/receivables/aging/export?format=xlsx");
    const totalRow = agingRows.find((r) => r[0] === "Total");
    expect(totalRow?.[3]).toBe(aging.totalOpenCentavos / 100);

    const first = (await db.execute<{ v: string }>(sql`SELECT min(payment_date)::text AS v FROM payments`)).rows[0]!.v;
    const collections = await getCollectionsReport(db, { from: first, to: today, groupBy: "month" });
    const collectionRows = await xlsxRows(`/reports/collections/export?format=xlsx&from=${first}&to=${today}&groupBy=month`);
    const labels = collectionRows.findIndex((r) => r.includes("Net collected"));
    const column = collectionRows[labels]!.indexOf("Net collected");
    expect(collectionRows[labels + 1]![column]).toBe(collections.totals.netCentavos / 100);

    for (const url of ["/receivables/aging/export?format=pdf", `/reports/collections/export?format=pdf&from=${first}&to=${today}&groupBy=month`]) {
      const pdf = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("passes the same integrity check that backups and restores run", async () => {
    const report = await runIntegrityChecks(pool, { proofDir: path.join(workDir, "proofs") });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });
});
