import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  collectorCreateSchema,
  formatPesos,
  periodBounds,
  periodLabel,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createCollector } from "../collection/service";
import { dbToday } from "../db/query_helpers";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

/*
 * The spec's mandatory acceptance tests (section 7), AT-01 to AT-12, with the spec's own test
 * data, run through the HTTP API exactly as the desktop app calls it: signed in as the real
 * roles, with bearer tokens. Setup (plans, subscribers, installations) uses the services
 * directly; every step under test goes over HTTP.
 *
 * Each test also records what it observed. `pnpm --filter ./apps/api acceptance` runs this
 * file with ACCEPTANCE_EVIDENCE set and turns the result into tests/acceptance-test-report.
 * The tests run in order and share one database; AT-12 restores a backup, so it runs last.
 */

const PASSWORD = "Accept-Test-2026";
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/fixtures");
const { db, pool } = createTestDb();

let app: FastifyInstance;
let workDir: string;
const tokens: Record<string, string> = {};
let today: string;
let monthA: string; // the spec's "August": two months back
let monthB: string; // the spec's "September": last month
let monthC: string; // this month

interface Evidence {
  id: string;
  title: string;
  data: string;
  expected: string;
  observed: string[];
}
const evidence: Evidence[] = [];
function record(id: string, title: string, data: string, expected: string, observed: string[]) {
  evidence.push({ id, title, data, expected, observed });
}
const peso = (centavos: number) => formatPesos(centavos);

/* --------------------------------- HTTP --------------------------------- */

function call(role: string, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

interface InvoiceView {
  id: string;
  invoiceNumber: string;
  periodStart: string;
  status: string;
  displayStatus: string;
  totalCentavos: number;
  paidCentavos: number;
  balanceCentavos: number;
}

async function invoicesOf(subscriberId: string): Promise<InvoiceView[]> {
  const res = await call("admin", "GET", `/invoices?subscriberId=${subscriberId}&pageSize=50`);
  expect(res.statusCode).toBe(200);
  return (res.json().items as InvoiceView[]).toSorted((a, b) => a.periodStart.localeCompare(b.periodStart));
}

async function invoice(id: string): Promise<InvoiceView> {
  const res = await call("admin", "GET", `/invoices/${id}`);
  expect(res.statusCode).toBe(200);
  return res.json() as InvoiceView;
}

async function ledger(subscriberId: string) {
  const res = await call("admin", "GET", `/subscribers/${subscriberId}/ledger`);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    entries: unknown[];
    closingBalanceCentavos: number;
    totalDebitCentavos: number;
    totalCreditCentavos: number;
  };
}

function pay(role: string, subscriberId: string, amountCentavos: number) {
  return call(role, "POST", "/payments", { subscriberId, method: "cash", amountCentavos });
}

async function bill(period: string) {
  const generated = await call("admin", "POST", "/billing/generate", { period });
  expect(generated.statusCode).toBe(200);
  const finalized = await call("admin", "POST", "/billing/finalize", { period });
  expect(finalized.statusCode).toBe(200);
  return { generated: generated.json(), finalized: finalized.json() };
}

/* -------------------------------- Setup -------------------------------- */

const ids: Record<string, string> = {};

async function subscriberOn(
  key: string,
  planId: string,
  activeFrom: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const subscriber = await createSubscriber(
    db,
    ids.owner!,
    subscriberCreateSchema.parse({
      fullName: `Acceptance ${key}`,
      billingDay: 5,
      address: { line1: "Purok 1", barangay: "Poblacion", city: "Maramag" },
      ...extra,
    }),
  );
  const service = await createServiceAccount(
    db,
    ids.owner!,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    ids.owner!,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: activeFrom }),
  );
  ids[key] = subscriber.id;
  return subscriber.id;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(
    sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas, backup_history, integrity_checks CASCADE`,
  );
  workDir = await mkdtemp(path.join(os.tmpdir(), "bcis-acceptance-"));

  ids.owner = await createTestUser(db, "acc_owner", PASSWORD, "owner");
  await createTestUser(db, "acc_admin", PASSWORD, "administrator");
  await createTestUser(db, "acc_cashier", PASSWORD, "cashier");
  await createTestUser(db, "acc_cashier2", PASSWORD, "cashier");
  await createTestUser(db, "acc_supervisor", PASSWORD, "collection_supervisor");

  today = await dbToday(db);
  monthC = periodOf(today);
  monthB = addMonths(monthC, -1);
  monthA = addMonths(monthC, -2);

  const plan = async (code: string, priceCentavos: number) =>
    (
      await createPlan(
        db,
        ids.owner!,
        planCreateSchema.parse({ code, name: `Plan ${formatPesos(priceCentavos)}`, serviceType: "internet", priceCentavos }),
      )
    ).id;
  const p999 = await plan("ACC-999", 99_900);
  const p1000 = await plan("ACC-1000", 100_000);
  const p10000 = await plan("ACC-10000", 1_000_000);

  const startA = periodBounds(monthA).start;
  const startB = periodBounds(monthB).start;
  await subscriberOn("at01", p999, startB);
  await subscriberOn("at02", p999, startB);
  await subscriberOn("at03", p1000, startB);
  await subscriberOn("at04", p999, startA);
  await subscriberOn("at05", p999, startB);
  await subscriberOn("at06", p999, startB);
  for (const [batchKey, code] of [
    ["at07", "ACC-C7"],
    ["at08", "ACC-C8"],
  ] as const) {
    const collector = await createCollector(db, ids.owner, collectorCreateSchema.parse({ code, fullName: `Collector ${code}` }));
    ids[`${batchKey}-collector`] = collector.id;
    await subscriberOn(`${batchKey}a`, p10000, startB, { assignedCollectorId: collector.id });
    await subscriberOn(`${batchKey}b`, p10000, startB, { assignedCollectorId: collector.id });
  }
  for (const n of [1, 2, 3]) await subscriberOn(`at09-${n}`, p999, startB);

  const config = testConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
    PROOF_STORAGE_DIR: path.join(workDir, "proofs"),
    BACKUP_DIR: path.join(workDir, "backups"),
  });
  app = buildApp(config, { db, pool });
  await app.ready();
  for (const role of ["owner", "admin", "cashier", "cashier2", "supervisor"]) tokens[role] = await login(`acc_${role}`);

  // The spec's two past months, billed through the API.
  await bill(monthA);
  await bill(monthB);
});

afterAll(async () => {
  if (process.env.ACCEPTANCE_EVIDENCE) {
    const version = await db.execute<{ server_version: string }>(sql`SHOW server_version`);
    await writeFile(
      process.env.ACCEPTANCE_EVIDENCE,
      JSON.stringify(
        { today, postgres: version.rows[0]?.server_version, months: { monthA, monthB, monthC }, evidence },
        null,
        2,
      ),
    );
  }
  await app.close();
  await pool.end();
  await rm(workDir, { recursive: true, force: true });
});

/* ------------------------------- The tests ------------------------------- */

describe("Mandatory acceptance tests (spec section 7)", () => {
  it("AT-01 Exact payment: ₱999 on a ₱999 invoice leaves ₱0, PAID, ledger balanced, receipt created", async () => {
    const [bill999] = await invoicesOf(ids.at01!);
    expect(bill999!.totalCentavos).toBe(99_900);

    const res = await pay("cashier", ids.at01!, 99_900);
    expect(res.statusCode).toBe(200);
    const payment = res.json();
    expect(payment.receiptNumber).toMatch(/^RCPT-\d{6}$/);
    expect(payment.allocations).toEqual([expect.objectContaining({ invoiceId: bill999!.id, amountCentavos: 99_900 })]);

    const after = await invoice(bill999!.id);
    expect(after).toMatchObject({ status: "paid", balanceCentavos: 0 });
    const book = await ledger(ids.at01!);
    expect(book.closingBalanceCentavos).toBe(0);
    expect(book.totalDebitCentavos).toBe(book.totalCreditCentavos);
    const receipt = await call("cashier", "GET", `/payments/${payment.id}`);
    expect(receipt.json()).toMatchObject({ receiptNumber: payment.receiptNumber, status: "posted" });

    record("AT-01", "Exact payment", "Invoice ₱999; payment ₱999", "Remaining ₱0; invoice PAID; ledger balanced; receipt created.", [
      `Invoice ${after.invoiceNumber}: total ${peso(after.totalCentavos)}, paid ${peso(after.paidCentavos)}, remaining ${peso(after.balanceCentavos)}, status ${after.status}.`,
      `Ledger: debits ${peso(book.totalDebitCentavos)} = credits ${peso(book.totalCreditCentavos)}; balance ${peso(book.closingBalanceCentavos)}.`,
      `Receipt ${payment.receiptNumber} issued (${payment.method}, ${peso(payment.amountCentavos)}), all of it applied to ${after.invoiceNumber}.`,
    ]);
  });

  it("AT-02 Partial payment: ₱500 on ₱999 leaves ₱499, PARTIALLY_PAID, allocation and ledger correct", async () => {
    const [bill999] = await invoicesOf(ids.at02!);
    const res = await pay("cashier", ids.at02!, 50_000);
    expect(res.statusCode).toBe(200);
    expect(res.json().allocations).toEqual([expect.objectContaining({ invoiceId: bill999!.id, amountCentavos: 50_000 })]);

    const after = await invoice(bill999!.id);
    expect(after).toMatchObject({ status: "partially_paid", paidCentavos: 50_000, balanceCentavos: 49_900 });
    const book = await ledger(ids.at02!);
    expect(book.closingBalanceCentavos).toBe(49_900);

    record("AT-02", "Partial payment", "Invoice ₱999; payment ₱500", "Remaining ₱499; PARTIALLY_PAID; allocation and ledger correct.", [
      `Invoice ${after.invoiceNumber}: paid ${peso(after.paidCentavos)}, remaining ${peso(after.balanceCentavos)}, stored status ${after.status} (shown as "${after.displayStatus}" because the due date has passed).`,
      `Allocation: ${peso(50_000)} of receipt ${res.json().receiptNumber} to ${after.invoiceNumber}.`,
      `Ledger balance ${peso(book.closingBalanceCentavos)} (debits ${peso(book.totalDebitCentavos)}, credits ${peso(book.totalCreditCentavos)}).`,
    ]);
  });

  it("AT-03 Advance payment: ₱3,000 on a ₱1,000 plan becomes credit used by later bills, nothing lost", async () => {
    const [first] = await invoicesOf(ids.at03!);
    expect(first!.totalCentavos).toBe(100_000);

    const res = await pay("cashier", ids.at03!, 300_000);
    expect(res.statusCode).toBe(200);
    const payment = res.json();
    expect(payment).toMatchObject({ allocatedCentavos: 100_000, creditCentavos: 200_000 });
    expect((await ledger(ids.at03!)).closingBalanceCentavos).toBe(-200_000);

    // Policy: credit is applied oldest-first when the next month is finalized.
    await bill(monthC);
    const bills = await invoicesOf(ids.at03!);
    expect(bills.map((b) => b.status)).toEqual(["paid", "paid"]);
    const later = (await call("cashier", "GET", `/payments/${payment.id}`)).json();
    expect(later).toMatchObject({ allocatedCentavos: 200_000, creditCentavos: 100_000 });
    expect(later.allocatedCentavos + later.creditCentavos).toBe(300_000);
    expect((await ledger(ids.at03!)).closingBalanceCentavos).toBe(-100_000);

    record(
      "AT-03",
      "Advance payment",
      "Monthly ₱1,000; payment ₱3,000",
      "Allocation/credit follows documented policy without losing value.",
      [
        `Policy: a payment pays open bills oldest-first; the rest is kept as credit and applied oldest-first when the next month is finalized.`,
        `On posting: ${peso(100_000)} to ${first!.invoiceNumber} (${periodLabel(monthB)}), ${peso(200_000)} kept as credit; ledger ${peso(-200_000)} (in the subscriber's favour).`,
        `After billing ${periodLabel(monthC)}: ${bills[1]!.invoiceNumber} paid from credit; receipt ${payment.receiptNumber} now ${peso(later.allocatedCentavos)} applied + ${peso(later.creditCentavos)} credit = ${peso(300_000)}. Ledger ${peso(-100_000)}.`,
      ],
    );
  });

  it("AT-04 Oldest-first arrears: ₱1,200 on two ₱999 bills clears the older, leaves ₱798 on the newer", async () => {
    const [older, newer] = (await invoicesOf(ids.at04!)).filter((b) => b.periodStart < periodBounds(monthC).start);
    expect([older!.periodStart, newer!.periodStart]).toEqual([periodBounds(monthA).start, periodBounds(monthB).start]);

    const res = await pay("cashier", ids.at04!, 120_000);
    expect(res.statusCode).toBe(200);
    expect(res.json().allocations.map((a: { invoiceId: string; amountCentavos: number }) => [a.invoiceId, a.amountCentavos])).toEqual([
      [older!.id, 99_900],
      [newer!.id, 20_100],
    ]);
    const a = await invoice(older!.id);
    const b = await invoice(newer!.id);
    expect(a.balanceCentavos).toBe(0);
    expect(b.balanceCentavos).toBe(79_800);

    record(
      "AT-04",
      "Oldest-first arrears",
      `${periodLabel(monthA)} ₱999 + ${periodLabel(monthB)} ₱999` +
        (periodLabel(monthA).startsWith("August") ? "" : " (standing in for the spec's August and September)") +
        "; payment ₱1,200",
      "August ₱0; September ₱798 remaining.",
      [
        `${a.invoiceNumber} (${periodLabel(monthA)}): ${peso(99_900)} applied, remaining ${peso(a.balanceCentavos)}, ${a.status}.`,
        `${b.invoiceNumber} (${periodLabel(monthB)}): ${peso(20_100)} applied, remaining ${peso(b.balanceCentavos)}, ${b.status}.`,
      ],
    );
  });

  it("AT-05 Duplicate GCash reference: a verified reference cannot be used again", async () => {
    const reference = `9${String(Date.now()).slice(-9)}05`;
    const submit = () =>
      call("cashier", "POST", "/gcash-submissions", {
        subscriberId: ids.at05,
        referenceNumber: reference,
        senderName: "Acceptance Sender",
        senderNumber: "0999 000 0005",
        amountCentavos: 99_900,
        transactionDate: today,
      });

    const first = await submit();
    expect(first.statusCode).toBe(200);
    const proof = await app.inject({
      method: "POST",
      url: `/gcash-submissions/${first.json().id}/proofs`,
      headers: { authorization: `Bearer ${tokens.cashier}`, "content-type": "image/png" },
      payload: await readFile(path.join(fixtures, "sample-proof.png")),
    });
    expect(proof.statusCode).toBe(200);
    const verified = await call("admin", "POST", `/gcash-submissions/${first.json().id}/verify`);
    expect(verified.statusCode).toBe(200);
    const paymentsBefore = (await call("admin", "GET", `/payments?subscriberId=${ids.at05}`)).json().total as number;

    const again = await submit();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("DUPLICATE_REFERENCE");
    const paymentsAfter = (await call("admin", "GET", `/payments?subscriberId=${ids.at05}`)).json().total as number;
    expect(paymentsAfter).toBe(paymentsBefore);

    record(
      "AT-05",
      "Duplicate GCash reference",
      `GCash reference ${reference}, verified once (with proof image), then submitted again`,
      "System blocks or explicitly warns according to documented verification policy.",
      [
        `Policy: a GCash reference can be used once; the server refuses a second submission (unique index on the normalized reference).`,
        `First submission verified: payment ${verified.json().paymentReceiptNumber ?? "posted"} for ${peso(99_900)}.`,
        `Second submission: HTTP ${again.statusCode} ${again.json().error}: "${again.json().message}"`,
        `Payments for the subscriber: ${paymentsBefore} before and ${paymentsAfter} after the attempt.`,
      ],
    );
  });

  it("AT-06 Payment reversal: original stays visible, reversal linked, balance restored, actor and reason audited", async () => {
    const before = await ledger(ids.at06!);
    const posted = await pay("cashier", ids.at06!, 99_900);
    expect(posted.statusCode).toBe(200);
    const paymentId = posted.json().id as string;
    const billId = posted.json().allocations[0].invoiceId as string;
    expect((await invoice(billId)).status).toBe("paid");

    const reason = "Posted to the wrong subscriber";
    const reversed = await call("admin", "POST", `/payments/${paymentId}/reverse`, { reason });
    expect(reversed.statusCode).toBe(200);

    const original = (await call("cashier", "GET", `/payments/${paymentId}`)).json();
    expect(original).toMatchObject({ status: "reversed", receiptNumber: posted.json().receiptNumber });
    expect(original.reversal).toMatchObject({ reason, reversedByName: "Test administrator" });
    const bill999 = await invoice(billId);
    expect(bill999.balanceCentavos).toBe(99_900);
    const after = await ledger(ids.at06!);
    expect(after.closingBalanceCentavos).toBe(before.closingBalanceCentavos);
    expect(after.entries.length).toBe(before.entries.length + 2);

    const audit = await call("admin", "GET", `/audit-logs?entityType=payment&entityId=${paymentId}`);
    const rows = audit.json().items as Array<{ action: string; reason: string | null; actor: { fullName: string } | null }>;
    const reversal = rows.find((r) => r.action === "payment.reverse");
    expect(reversal).toMatchObject({ reason, actor: { fullName: "Test administrator" } });

    record("AT-06", "Payment reversal", "Reverse an incorrectly posted ₱999 cash payment", "Original remains visible; linked reversal exists; balances restore; actor/reason audited.", [
      `Receipt ${original.receiptNumber} is still on file with status ${original.status}; reversal by ${original.reversal.reversedByName}: "${original.reversal.reason}".`,
      `Invoice ${bill999.invoiceNumber} back to ${peso(bill999.balanceCentavos)} owing (${bill999.status}).`,
      `Ledger balance ${peso(before.closingBalanceCentavos)} before, ${peso(after.closingBalanceCentavos)} after; two entries added (payment credit and reversal debit), none removed.`,
      `Audit: payment.reverse by ${reversal!.actor!.fullName}, reason "${reversal!.reason}".`,
    ]);
  });

  async function runBatch(key: "at07" | "at08", remitCentavos: number) {
    const created = await call("supervisor", "POST", "/collection-batches", {
      collectorId: ids[`${key}-collector`],
      collectionDate: today,
    });
    expect(created.statusCode).toBe(201);
    const batchId = created.json().batch.id as string;
    expect((await call("supervisor", "POST", `/collection-batches/${batchId}/dispatch`)).statusCode).toBe(200);
    for (const suffix of ["a", "b"]) {
      const collected = await call("supervisor", "POST", `/collection-batches/${batchId}/collections`, {
        subscriberId: ids[`${key}${suffix}`],
        method: "cash",
        amountCentavos: 1_000_000,
      });
      expect(collected.statusCode).toBe(201);
    }
    expect((await call("supervisor", "POST", `/collection-batches/${batchId}/submit`)).statusCode).toBe(200);
    const remitted = await call("supervisor", "POST", `/collection-batches/${batchId}/remittances`, { amountCentavos: remitCentavos });
    expect(remitted.statusCode).toBe(200);
    return { batchId, batch: remitted.json() as { batchNumber: string; money: { cashCollectedCentavos: number; remittedCentavos: number } } };
  }

  it("AT-07 Collector balanced remittance: ₱20,000 collected and remitted, difference ₱0, batch closes", async () => {
    const { batchId, batch } = await runBatch("at07", 2_000_000);
    expect(batch.money).toMatchObject({ cashCollectedCentavos: 2_000_000, remittedCentavos: 2_000_000 });

    const reconciled = await call("supervisor", "POST", `/collection-batches/${batchId}/reconcile`, { differenceCentavos: 0 });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().reconciliation).toMatchObject({ differenceCentavos: 0, varianceKind: "balanced" });
    const closed = await call("supervisor", "POST", `/collection-batches/${batchId}/close`, { differenceCentavos: 0 });
    expect(closed.json().status).toBe("closed");

    record("AT-07", "Collector balanced remittance", "Cash collected ₱20,000; remitted ₱20,000", "Difference ₱0; batch may reconcile/close.", [
      `Batch ${batch.batchNumber}: cash collected ${peso(batch.money.cashCollectedCentavos)} (two field collections of ₱10,000), remitted ${peso(batch.money.remittedCentavos)}.`,
      `Reconciled: difference ${peso(0)}, ${reconciled.json().reconciliation.varianceKind}. Closed: status ${closed.json().status}.`,
    ]);
  });

  it("AT-08 Collector shortage: ₱20,000 collected, ₱19,500 remitted shows ₱500 short and cannot close as balanced", async () => {
    const { batchId, batch } = await runBatch("at08", 1_950_000);
    expect(batch.money).toMatchObject({ cashCollectedCentavos: 2_000_000, remittedCentavos: 1_950_000 });

    const asBalanced = await call("supervisor", "POST", `/collection-batches/${batchId}/reconcile`, { differenceCentavos: 0 });
    expect(asBalanced.statusCode).toBe(409);
    const noReason = await call("supervisor", "POST", `/collection-batches/${batchId}/reconcile`, { differenceCentavos: -50_000 });
    expect(noReason.statusCode).toBe(400);
    const reconciled = await call("supervisor", "POST", `/collection-batches/${batchId}/reconcile`, {
      differenceCentavos: -50_000,
      varianceReason: "Collector short ₱500; to be settled",
    });
    expect(reconciled.json().reconciliation).toMatchObject({ differenceCentavos: -50_000, varianceKind: "shortage" });
    const silent = await call("supervisor", "POST", `/collection-batches/${batchId}/close`, { differenceCentavos: 0 });
    expect(silent.statusCode).toBe(409);
    const closed = await call("supervisor", "POST", `/collection-batches/${batchId}/close`, { differenceCentavos: -50_000 });
    expect(closed.json()).toMatchObject({ status: "closed", reconciliation: { varianceKind: "shortage", differenceCentavos: -50_000 } });

    record("AT-08", "Collector shortage", "Cash collected ₱20,000; remitted ₱19,500", "₱500 shortage displayed; cannot silently close as balanced.", [
      `Batch ${batch.batchNumber}: collected ${peso(2_000_000)}, remitted ${peso(1_950_000)}.`,
      `Reconcile as balanced: HTTP ${asBalanced.statusCode} "${asBalanced.json().message}"`,
      `Reconcile without a reason: HTTP ${noReason.statusCode} (${noReason.json().issues[0].message})`,
      `Reconciled with reason: difference ${peso(-50_000)}, ${reconciled.json().reconciliation.varianceKind}.`,
      `Close confirming ₱0: HTTP ${silent.statusCode} "${silent.json().message}". Close confirming the shortage: ${closed.json().status}, shortage kept on the batch.`,
    ]);
  });

  it("AT-09 Concurrent users: three sessions posting and reading at once keep numbers and balances right", async () => {
    const sessions = ["cashier", "cashier2", "admin"] as const;
    const before = await Promise.all([1, 2, 3].map(async (n) => (await ledger(ids[`at09-${n}`]!)).closingBalanceCentavos));

    const work = sessions.flatMap((role, i) =>
      Array.from({ length: 5 }, () => [pay(role, ids[`at09-${i + 1}`]!, 10_000), call(role, "GET", "/payments?pageSize=5")]).flat(),
    );
    const results = await Promise.all(work);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);

    const receipts = results
      .filter((r) => r.json().receiptNumber)
      .map((r) => r.json<{ receiptNumber: string; receivedByName: string }>());
    const numbers = receipts.map((r) => Number(r.receiptNumber.slice(5))).toSorted((a, b) => a - b);
    expect(new Set(numbers).size).toBe(15);
    expect(numbers.at(-1)! - numbers[0]!).toBe(14); // no gaps, no repeats
    const after = await Promise.all([1, 2, 3].map(async (n) => (await ledger(ids[`at09-${n}`]!)).closingBalanceCentavos));
    expect(after).toEqual(before.map((b) => b - 50_000));

    // Signing one session out does not touch the others.
    expect((await call("cashier2", "POST", "/auth/logout")).statusCode).toBe(200);
    expect((await call("cashier2", "GET", "/payments?pageSize=1")).statusCode).toBe(401);
    expect((await call("cashier", "GET", "/payments?pageSize=1")).statusCode).toBe(200);
    expect((await call("admin", "GET", "/payments?pageSize=1")).statusCode).toBe(200);

    record(
      "AT-09",
      "Concurrent users",
      "Three signed-in sessions (two cashiers, one administrator) each post 5 payments of ₱100 and read the payment list, all at the same time",
      "No data corruption, duplicate numbering or unauthorized cross-session effect.",
      [
        `30 requests in parallel, all HTTP 200. 15 receipts ${receipts.map((r) => r.receiptNumber).toSorted()[0]} to ${receipts.map((r) => r.receiptNumber).toSorted().at(-1)}: no repeats, no gaps.`,
        `Each subscriber's balance went down by exactly ${peso(50_000)} (${before.map(peso).join(", ")} → ${after.map(peso).join(", ")}).`,
        `Each receipt names the user of the session that posted it.`,
        `After one cashier signed out: that token gets 401; the other two sessions still get 200.`,
        `Larger runs: apps/api/src/concurrency/at09.test.ts (billing, 30 payments, field collections, adjustments in parallel) and the three-PC script \`pnpm --filter ./apps/api concurrency\`.`,
      ],
    );
    tokens.cashier2 = await login("acc_cashier2");
    expect(receipts.every((r) => ["Test cashier", "Test administrator"].includes(r.receivedByName))).toBe(true);
  });

  it("AT-10 Authorization: a cashier calling user and backup operations directly is refused by the server", async () => {
    const userCount = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM users`)).rows[0]!.n);
    const backupCount = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM backup_history`)).rows[0]!.n);
    const users0 = await userCount();
    const backups0 = await backupCount();

    const attempts = [
      ["POST /admin/users", await call("cashier", "POST", "/admin/users", {
        username: "sneaky.user",
        fullName: "Sneaky User",
        temporaryPassword: "Temp-Pass-2026",
        roles: ["owner"],
      })],
      ["GET /admin/users", await call("cashier", "GET", "/admin/users")],
      ["POST /backups", await call("cashier", "POST", "/backups", { note: "not allowed" })],
      ["GET /backups", await call("cashier", "GET", "/backups")],
    ] as const;
    for (const [, res] of attempts) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("FORBIDDEN");
    }
    const anonymous = await app.inject({ method: "POST", url: "/backups", payload: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(await userCount()).toBe(users0);
    expect(await backupCount()).toBe(backups0);

    record("AT-10", "Authorization", "Cashier calls admin-only user and backup endpoints directly (no UI)", "Server rejects operation even if API is called directly.", [
      ...attempts.map(([label, res]) => `${label} as cashier: HTTP ${res.statusCode} ${res.json().error}.`),
      `POST /backups without a token: HTTP ${anonymous.statusCode}.`,
      `Users ${users0} → ${await userCount()}, backups ${backups0} → ${await backupCount()}: nothing was created.`,
      `Every route is covered the same way by apps/api/src/security/route-guards.test.ts (401 without a token, 403 without the permission).`,
    ]);
  });

  it("AT-11 Duplicate billing: generating and finalizing the same month twice creates no second invoice", async () => {
    const countFor = async () =>
      Number(
        (
          await db.execute(
            sql`SELECT count(*)::int AS n FROM invoices WHERE period_start = ${periodBounds(monthB).start} AND status <> 'void'`,
          )
        ).rows[0]!.n,
      );
    const before = await countFor();
    const runs = [];
    for (let n = 0; n < 2; n++) {
      const generated = await call("admin", "POST", "/billing/generate", { period: monthB });
      expect(generated.statusCode).toBe(200);
      expect(generated.json().drafts.count).toBe(0);
      const finalized = await call("admin", "POST", "/billing/finalize", { period: monthB });
      expect(finalized.statusCode).toBe(409);
      expect(finalized.json().error).toBe("NOTHING_TO_FINALIZE");
      runs.push({ drafts: generated.json().drafts.count as number, finalize: `HTTP ${finalized.statusCode} ${finalized.json().error}` });
    }
    expect(await countFor()).toBe(before);
    const duplicates = await db.execute(sql`
      SELECT service_account_id FROM invoices WHERE status <> 'void'
      GROUP BY service_account_id, period_start HAVING count(*) > 1`);
    expect(duplicates.rows).toEqual([]);
    const index = await db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'invoices' AND indexdef LIKE 'CREATE UNIQUE%period_start%'`,
    );
    expect(index.rows.length).toBeGreaterThan(0);

    record("AT-11", "Duplicate billing", `Run billing generation and finalization for ${periodLabel(monthB)} twice more`, "No duplicate finalized invoice for same service account/period.", [
      `Live invoices for ${periodLabel(monthB)}: ${before} before, ${await countFor()} after two more runs.`,
      ...runs.map((r, n) => `Run ${n + 1}: generate created ${r.drafts} drafts; finalize answered ${r.finalize} (nothing new to number).`),
      `No service account has two live invoices for any month.`,
      `Database guard: ${index.rows[0]!.indexdef.replace(/ USING btree/, "")}.`,
    ]);
  });

  it("AT-12 Backup/restore: back up, change data, restore; integrity passes and the records return", { timeout: 120_000 }, async () => {
    const backup = await call("owner", "POST", "/backups", { note: "AT-12" });
    expect(backup.statusCode).toBe(201);
    const { id: backupId, backupNumber, verificationStatus } = backup.json();
    expect(verificationStatus).toBe("passed");
    const paymentsAtBackup = (await call("admin", "GET", "/payments?pageSize=1")).json().total as number;

    const change = await pay("cashier", ids.at01!, 10_000);
    expect(change.statusCode).toBe(200);
    expect((await call("admin", "GET", "/payments?pageSize=1")).json().total).toBe(paymentsAtBackup + 1);

    const restored = await call("owner", "POST", `/backups/${backupId}/restore`, {
      confirmBackupNumber: backupNumber,
      reason: "AT-12 acceptance test",
    });
    expect(restored.statusCode).toBe(200);
    const report = restored.json().report as { passed: boolean; checks: Array<{ code: string; passed: boolean; detail: string }> };
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);

    // Restoring signs everyone out; sign in again and look.
    expect((await call("owner", "GET", "/backups")).statusCode).toBe(401);
    tokens.owner = await login("acc_owner");
    tokens.admin = await login("acc_admin");
    const paymentsAfter = (await call("admin", "GET", "/payments?pageSize=1")).json().total as number;
    expect(paymentsAfter).toBe(paymentsAtBackup);
    expect((await call("admin", "GET", `/payments/${change.json().id}`)).statusCode).toBe(404);

    record("AT-12", "Backup/restore", "Create a backup, post a ₱100 payment, restore the backup", "Restored database passes integrity check and expected records return.", [
      `Backup ${backupNumber} created and verified (checksums + pg_restore --list).`,
      `Payments: ${paymentsAtBackup} at backup, ${paymentsAtBackup + 1} after the change, ${paymentsAfter} after restoring; receipt ${change.json().receiptNumber} (made after the backup) is gone.`,
      `A safety backup ${restored.json().safetyBackupNumber} was taken before restoring.`,
      `Integrity check after restore: ${report.checks.map((c) => `${c.code} ${c.passed ? "passed" : "FAILED"}`).join(", ")}.`,
      `All sessions were signed out by the restore (old token: HTTP 401).`,
    ]);
  });
});
