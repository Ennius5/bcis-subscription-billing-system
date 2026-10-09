import { and, eq, sql } from "drizzle-orm";
import {
  addMonths,
  billingRunSchema,
  parsePesos,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
  type PaymentCreateInput,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { getSubscriberBalance, getSubscriberLedger } from "../billing/ledger";
import { dbToday } from "../db/query_helpers";
import { auditLogs, documentSequences, invoices, ledgerEntries, paymentAllocations, payments } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { getSubscriberCredit, postPayment, reversePayment } from "./service";

// Integration tests for the payment rules, through the real billing service: invoices are
// generated and finalized, then paid. Months are relative to the database's today.

const { db, pool } = createTestDb();
let actorId: string;
let today: string;
let thisMonth: string;
let lastMonth: string;
let nextMonth: string;
let plan999: string;
let plan1000: string;

async function makeSubscriber(fullName: string, planId: string): Promise<string> {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay: 5,
      address: { line1: "Purok 2", barangay: "Poblacion", city: "Maramag" },
    }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    actorId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
  );
  return subscriber.id;
}

/** Generate and finalize a month. Other tests' accounts are billed too; assertions only look at their own subscriber. */
async function bill(period: string) {
  await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period }));
  return finalizeBilling(db, actorId, billingRunSchema.parse({ period }));
}

function pay(subscriberId: string, amount: string, extra: Partial<PaymentCreateInput> = {}) {
  return postPayment(
    db,
    actorId,
    paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: parsePesos(amount), ...extra }),
  );
}

async function invoicesOf(subscriberId: string) {
  return db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      periodStart: invoices.periodStart,
      status: invoices.status,
      paidCentavos: invoices.paidCentavos,
      totalCentavos: invoices.totalCentavos,
    })
    .from(invoices)
    .where(and(eq(invoices.subscriberId, subscriberId), sql`${invoices.status} <> 'draft'`))
    .orderBy(invoices.periodStart);
}

/**
 * The Phase 5 invariant: what the ledger says the subscriber owes equals what is still open
 * on their invoices minus the payment money not yet applied to any invoice.
 */
async function expectBalanced(subscriberId: string) {
  const open = (await invoicesOf(subscriberId))
    .filter((i) => i.status !== "void")
    .reduce((sum, i) => sum + i.totalCentavos - i.paidCentavos, 0);
  const credit = await getSubscriberCredit(db, subscriberId);
  expect(await getSubscriberBalance(db, subscriberId)).toBe(open - credit);
}

async function receiptCounter(): Promise<number> {
  const [row] = await db.select().from(documentSequences).where(eq(documentSequences.name, "receipt"));
  return row!.nextValue;
}

async function auditRows(action: string, entityId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "payment_actor", "Passw0rd!test", "cashier");

  today = await dbToday(db);
  thisMonth = periodOf(today);
  lastMonth = addMonths(thisMonth, -1);
  nextMonth = addMonths(thisMonth, 1);

  plan999 = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  plan1000 = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-1000", name: "Internet 1000", serviceType: "internet", priceCentavos: 100_000 }),
    )
  ).id;
});

afterAll(async () => {
  await pool.end();
});

describe("AT-01: exact payment", () => {
  it("pays the invoice, posts a receipt and balances the ledger", async () => {
    const subscriberId = await makeSubscriber("Exact Payer", plan999);
    await bill(lastMonth);

    const payment = await pay(subscriberId, "999");

    expect(payment.receiptNumber).toMatch(/^RCPT-\d{6}$/);
    expect(payment).toMatchObject({ status: "posted", amountCentavos: 99_900, allocatedCentavos: 99_900, creditCentavos: 0 });
    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]).toMatchObject({ amountCentavos: 99_900, source: "auto" });

    const [invoice] = await invoicesOf(subscriberId);
    expect(invoice).toMatchObject({ status: "paid", paidCentavos: 99_900 });
    expect(await getSubscriberBalance(db, subscriberId)).toBe(0);

    const ledger = await getSubscriberLedger(db, subscriberId);
    expect(ledger.entries.at(-1)).toMatchObject({
      entryType: "payment",
      reference: payment.receiptNumber,
      description: "Cash payment",
      creditCentavos: 99_900,
      balanceCentavos: 0,
    });
    const [audit] = await auditRows("payment.post", payment.id);
    expect(audit?.actorUserId).toBe(actorId);
    expect(audit?.newValues).toMatchObject({ receiptNumber: payment.receiptNumber, creditCentavos: 0 });
  });
});

describe("AT-02: partial payment", () => {
  it("leaves ₱499 and marks the invoice partially paid", async () => {
    const subscriberId = await makeSubscriber("Partial Payer", plan999);
    await bill(lastMonth);

    await pay(subscriberId, "500");

    const [invoice] = await invoicesOf(subscriberId);
    expect(invoice).toMatchObject({ status: "partially_paid", paidCentavos: parsePesos("500") });
    expect(await getSubscriberBalance(db, subscriberId)).toBe(parsePesos("499"));
    const allocations = await db.select().from(paymentAllocations).where(eq(paymentAllocations.invoiceId, invoice!.id));
    expect(allocations.map((a) => a.amountCentavos)).toEqual([parsePesos("500")]);
    await expectBalanced(subscriberId);
  });
});

describe("AT-04: oldest-first arrears", () => {
  it("clears last month, then puts the rest on this month", async () => {
    const subscriberId = await makeSubscriber("Arrears Payer", plan999);
    await bill(lastMonth);
    await bill(thisMonth);

    await pay(subscriberId, "1200");

    const [older, newer] = await invoicesOf(subscriberId);
    expect(older).toMatchObject({ status: "paid", paidCentavos: 99_900 });
    expect(newer).toMatchObject({ status: "partially_paid", paidCentavos: parsePesos("201") });
    expect(newer!.totalCentavos - newer!.paidCentavos).toBe(parsePesos("798"));
    expect(await getSubscriberBalance(db, subscriberId)).toBe(parsePesos("798"));
    await expectBalanced(subscriberId);
  });
});

describe("AT-03: advance payment", () => {
  it("keeps the extra as credit and applies it when the next month is finalized", async () => {
    const subscriberId = await makeSubscriber("Advance Payer", plan1000);
    await bill(lastMonth);
    await bill(thisMonth);
    await pay(subscriberId, "2000"); // clears both months first

    const payment = await pay(subscriberId, "3000");
    expect(payment).toMatchObject({ allocatedCentavos: 0, creditCentavos: parsePesos("3000") });
    expect(await getSubscriberCredit(db, subscriberId)).toBe(parsePesos("3000"));
    expect(await getSubscriberBalance(db, subscriberId)).toBe(-parsePesos("3000"));
    await expectBalanced(subscriberId);

    const result = await bill(nextMonth);
    expect(result.creditAppliedCentavos).toBeGreaterThanOrEqual(parsePesos("1000"));

    const next = (await invoicesOf(subscriberId)).at(-1)!;
    expect(next).toMatchObject({ status: "paid", paidCentavos: parsePesos("1000") });
    expect(await getSubscriberCredit(db, subscriberId)).toBe(parsePesos("2000"));
    expect(await getSubscriberBalance(db, subscriberId)).toBe(-parsePesos("2000"));
    await expectBalanced(subscriberId);

    const applied = await db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id));
    expect(applied.map((a) => [a.invoiceId, a.amountCentavos, a.source])).toEqual([[next.id, parsePesos("1000"), "credit"]]);
    expect(await auditRows("payment.apply_credit", payment.id)).toHaveLength(1);
    // Applying credit moves no money, so there is no new ledger line for it.
    const ledgerForPayment = await db.select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, payment.id));
    expect(ledgerForPayment).toHaveLength(1);
  });

  it("pays what is open and keeps the rest when invoices are owed", async () => {
    const subscriberId = await makeSubscriber("Partly Advance", plan1000);
    await bill(lastMonth);

    const payment = await pay(subscriberId, "3000");
    expect(payment).toMatchObject({ allocatedCentavos: parsePesos("1000"), creditCentavos: parsePesos("2000") });
    await expectBalanced(subscriberId);
  });
});

describe("manual allocation", () => {
  it("pays the chosen invoice and keeps the remainder as credit", async () => {
    const subscriberId = await makeSubscriber("Chooses Invoice", plan999);
    await bill(lastMonth);
    await bill(thisMonth);
    const [older, newer] = await invoicesOf(subscriberId);

    const payment = await pay(subscriberId, "1200", { allocations: [{ invoiceId: newer!.id, amountCentavos: 99_900 }] });

    expect(payment.allocations.map((a) => [a.invoiceId, a.source])).toEqual([[newer!.id, "manual"]]);
    expect(payment.creditCentavos).toBe(parsePesos("201"));
    const [olderAfter, newerAfter] = await invoicesOf(subscriberId);
    expect(olderAfter).toMatchObject({ id: older!.id, status: "unpaid" });
    expect(newerAfter).toMatchObject({ status: "paid" });
    await expectBalanced(subscriberId);
  });

  it("refuses another subscriber's invoice without posting anything", async () => {
    const subscriberId = await makeSubscriber("Wrong Invoice", plan999);
    const otherId = await makeSubscriber("Other Owner", plan999);
    await bill(lastMonth);
    const [othersInvoice] = await invoicesOf(otherId);
    const counter = await receiptCounter();

    await expect(
      pay(subscriberId, "999", { allocations: [{ invoiceId: othersInvoice!.id, amountCentavos: 99_900 }] }),
    ).rejects.toMatchObject({ code: "ALLOCATION_INVALID" });
    expect(await receiptCounter()).toBe(counter);
    expect(await db.select().from(payments).where(eq(payments.subscriberId, subscriberId))).toHaveLength(0);
  });
});

describe("payment date", () => {
  it("may be backdated, and the ledger line uses that date", async () => {
    const subscriberId = await makeSubscriber("Backdated", plan999);
    await bill(lastMonth);
    const paidOn = periodBounds(lastMonth).end;

    const payment = await pay(subscriberId, "999", { paymentDate: paidOn });

    expect(payment.paymentDate).toBe(paidOn);
    const ledger = await getSubscriberLedger(db, subscriberId);
    expect(ledger.entries.find((e) => e.entryType === "payment")?.entryDate).toBe(paidOn);
  });

  it("cannot be in the future, and a refused payment takes no receipt number or audit row", async () => {
    const subscriberId = await makeSubscriber("Future Date", plan999);
    const counter = await receiptCounter();
    const audits = (await db.select().from(auditLogs).where(eq(auditLogs.action, "payment.post"))).length;

    await expect(
      pay(subscriberId, "999", { paymentDate: periodBounds(nextMonth).end }),
    ).rejects.toMatchObject({ code: "PAYMENT_DATE_IN_FUTURE" });
    expect(await receiptCounter()).toBe(counter);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "payment.post"))).length).toBe(audits);
  });

  it("needs an existing subscriber", async () => {
    await expect(
      pay("00000000-0000-4000-8000-000000000099", "100"),
    ).rejects.toMatchObject({ code: "SUBSCRIBER_NOT_FOUND" });
  });
});

describe("AT-06: payment reversal", () => {
  it("keeps the original, restores the balances and audits who and why", async () => {
    const subscriberId = await makeSubscriber("Reversed Payer", plan999);
    await bill(lastMonth);
    await bill(thisMonth);
    const before = await getSubscriberBalance(db, subscriberId);
    const payment = await pay(subscriberId, "1200", { method: "cheque", referenceNumber: "CHK-0001" });

    const reversed = await reversePayment(db, actorId, payment.id, { reason: "Cheque bounced" });

    expect(reversed).toMatchObject({ status: "reversed", receiptNumber: payment.receiptNumber, creditCentavos: 0 });
    expect(reversed.reversal).toMatchObject({ reason: "Cheque bounced" });
    // The allocations stay as history.
    expect(reversed.allocations).toHaveLength(2);

    for (const invoice of await invoicesOf(subscriberId)) {
      expect(invoice).toMatchObject({ status: "unpaid", paidCentavos: 0 });
    }
    expect(await getSubscriberBalance(db, subscriberId)).toBe(before);
    await expectBalanced(subscriberId);

    const ledger = await getSubscriberLedger(db, subscriberId);
    const lines = ledger.entries.filter((e) => e.reference === payment.receiptNumber);
    expect(lines.map((e) => [e.entryType, e.debitCentavos, e.creditCentavos])).toEqual([
      ["payment", 0, parsePesos("1200")],
      ["payment_reversal", parsePesos("1200"), 0],
    ]);

    const [audit] = await auditRows("payment.reverse", payment.id);
    expect(audit).toMatchObject({ actorUserId: actorId, reason: "Cheque bounced" });
    expect(audit?.newValues).toMatchObject({ status: "reversed", receiptNumber: payment.receiptNumber });
  });

  it("cannot reverse twice", async () => {
    const subscriberId = await makeSubscriber("Twice Reversed", plan999);
    const payment = await pay(subscriberId, "100");
    await reversePayment(db, actorId, payment.id, { reason: "Wrong subscriber" });
    await expect(
      reversePayment(db, actorId, payment.id, { reason: "Again" }),
    ).rejects.toMatchObject({ code: "PAYMENT_ALREADY_REVERSED" });
    expect(await auditRows("payment.reverse", payment.id)).toHaveLength(1);
  });

  it("also undoes credit the payment applied later", async () => {
    const subscriberId = await makeSubscriber("Credit Then Reverse", plan1000);
    await bill(lastMonth);
    await bill(thisMonth);
    await pay(subscriberId, "2000");
    const advance = await pay(subscriberId, "1000"); // all credit
    await bill(nextMonth); // the credit pays next month

    await reversePayment(db, actorId, advance.id, { reason: "Posted twice" });

    const next = (await invoicesOf(subscriberId)).at(-1)!;
    expect(next).toMatchObject({ status: "unpaid", paidCentavos: 0 });
    expect(await getSubscriberCredit(db, subscriberId)).toBe(0);
    await expectBalanced(subscriberId);
  });

  it("lets other credit pay the invoices the reversal reopened", async () => {
    const subscriberId = await makeSubscriber("Reopened By Reversal", plan999);
    await bill(lastMonth);
    const first = await pay(subscriberId, "999");
    const second = await pay(subscriberId, "999"); // nothing open: all credit

    await reversePayment(db, actorId, first.id, { reason: "Wrong amount keyed" });

    const [invoice] = await invoicesOf(subscriberId);
    expect(invoice).toMatchObject({ status: "paid" });
    const allocations = await db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, second.id));
    expect(allocations.map((a) => [a.invoiceId, a.source])).toEqual([[invoice!.id, "credit"]]);
    expect(await getSubscriberBalance(db, subscriberId)).toBe(0);
    await expectBalanced(subscriberId);
  });

  it("needs an existing payment", async () => {
    await expect(
      reversePayment(db, actorId, "00000000-0000-4000-8000-000000000099", { reason: "Missing" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
  });
});

describe("AT-09: payments posted at the same time", () => {
  it("never share or skip a receipt number and never overpay an invoice", async () => {
    const subscriberId = await makeSubscriber("Busy Counter", plan999);
    await bill(lastMonth);
    await bill(thisMonth);

    const posted = await Promise.all(Array.from({ length: 5 }, () => pay(subscriberId, "500")));

    const numbers = posted.map((p) => Number(p.receiptNumber.slice(5))).toSorted((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers.at(-1)! - numbers[0]!).toBe(4);
    // ₱2,500 against ₱1,998 owed: both invoices paid, ₱502 credit.
    for (const invoice of await invoicesOf(subscriberId)) expect(invoice.status).toBe("paid");
    expect(await getSubscriberCredit(db, subscriberId)).toBe(parsePesos("502"));
    await expectBalanced(subscriberId);
  });
});
