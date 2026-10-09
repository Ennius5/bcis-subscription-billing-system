import { and, eq, sql } from "drizzle-orm";
import {
  addMonths,
  billingRunSchema,
  invoiceListQuerySchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceRateChangeSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
  subscriberStatusChangeSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbToday } from "../db/query_helpers";
import { auditLogs, invoiceItems, invoices, ledgerEntries } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceRate, changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { changeSubscriberStatus, createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { getSubscriberBalance, getSubscriberLedger } from "./ledger";
import {
  discardBillingDrafts,
  finalizeBilling,
  generateBillingDrafts,
  getBillingSummary,
  getInvoice,
  listInvoices,
  voidInvoice,
} from "./service";

const { db, pool } = createTestDb();
let actorId: string;

// Months are relative to the database's today, so the tests pass on any date.
let thisMonth: string;
let lastMonth: string;
let nextMonth: string;

// Ana: Internet 999.00 + 1,500.00 installation fee, billing from the 1st of last month, due day 5.
let ana: { subscriberId: string; serviceId: string };
// Ben: Cable 450.00, billing from the middle of this month (no proration: a full month).
let ben: { subscriberId: string; serviceId: string };
let pendingServiceId: string;
let suspendedServiceId: string;
let futureServiceId: string; // billing starts next month

const run = (period: string) => billingRunSchema.parse({ period });

async function invoicesFor(serviceId: string) {
  return db.select().from(invoices).where(eq(invoices.serviceAccountId, serviceId)).orderBy(invoices.periodStart);
}

async function auditCount(action: string) {
  return (await db.select().from(auditLogs).where(eq(auditLogs.action, action))).length;
}

async function makeService(fullName: string, planId: string, billingDay: number) {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay,
      address: { line1: "Purok 1", barangay: "Poblacion", city: "Maramag" },
    }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  return { subscriberId: subscriber.id, serviceId: service.id };
}

async function activate(serviceId: string, effectiveDate: string, billingStartDate?: string) {
  await changeServiceStatus(
    db,
    actorId,
    serviceId,
    serviceStatusChangeSchema.parse({
      status: "active",
      reason: "Installed",
      effectiveDate,
      ...(billingStartDate ? { billingStartDate } : {}),
    }),
  );
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "billing_actor", "Passw0rd!test", "administrator");

  thisMonth = periodOf(await dbToday(db));
  lastMonth = addMonths(thisMonth, -1);
  nextMonth = addMonths(thisMonth, 1);

  const internet = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({
      code: "inet-bill",
      name: "Internet 25 Mbps",
      serviceType: "internet",
      priceCentavos: 99_900,
      installationFeeCentavos: 150_000,
    }),
  );
  const cable = await createPlan(
    db,
    actorId,
    planCreateSchema.parse({ code: "cable-bill", name: "Cable Basic", serviceType: "cable", priceCentavos: 45_000 }),
  );

  ana = await makeService("Ana Billing", internet.id, 5);
  await activate(ana.serviceId, periodBounds(lastMonth).start);

  ben = await makeService("Ben Billing", cable.id, 10);
  await activate(ben.serviceId, `${thisMonth}-15`);

  pendingServiceId = (await makeService("Carla Pending", internet.id, 5)).serviceId;

  suspendedServiceId = (await makeService("Dan Suspended", internet.id, 5)).serviceId;
  await activate(suspendedServiceId, periodBounds(lastMonth).start);
  await changeServiceStatus(
    db,
    actorId,
    suspendedServiceId,
    serviceStatusChangeSchema.parse({ status: "suspended", reason: "Unpaid" }),
  );

  futureServiceId = (await makeService("Eva Next Month", internet.id, 5)).serviceId;
  await activate(futureServiceId, `${thisMonth}-01`, periodBounds(nextMonth).start);
});

afterAll(async () => {
  await pool.end();
});

describe("generating drafts", () => {
  it("drafts last month for Ana only, with the installation fee and the rate snapshot", async () => {
    const summary = await generateBillingDrafts(db, actorId, run(lastMonth));
    expect(summary.drafts).toEqual({ count: 1, totalCentavos: 99_900 + 150_000 });
    expect(summary.finalized.count).toBe(0);

    const [draft] = await invoicesFor(ana.serviceId);
    expect(draft).toMatchObject({
      status: "draft",
      invoiceNumber: null,
      invoiceDate: `${lastMonth}-01`,
      dueDate: `${lastMonth}-05`,
      totalCentavos: 249_900,
    });
    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, draft!.id)).orderBy(invoiceItems.lineNo);
    expect(items.map((i) => [i.itemType, i.amountCentavos])).toEqual([
      ["subscription", 99_900],
      ["installation_fee", 150_000],
    ]);
    expect(items[0]?.rateCentavos).toBe(99_900);

    // Drafts are not posted.
    expect(await getSubscriberBalance(db, ana.subscriberId)).toBe(0);
    expect(await auditCount("billing.generate")).toBe(1);
  });

  it("AT-11: generating the same month again creates nothing and audits nothing", async () => {
    const summary = await generateBillingDrafts(db, actorId, run(lastMonth));
    expect(summary.drafts.count).toBe(1);
    expect(summary.notYetBilled).toBe(0);
    expect(await invoicesFor(ana.serviceId)).toHaveLength(1);
    expect(await auditCount("billing.generate")).toBe(1);
  });

  it("refuses months more than one ahead, but allows next month", async () => {
    await expect(generateBillingDrafts(db, actorId, run(addMonths(thisMonth, 2)))).rejects.toMatchObject({
      code: "PERIOD_TOO_FAR",
      status: 422,
    });
    const next = await generateBillingDrafts(db, actorId, run(nextMonth));
    // Ana, Ben and Eva (whose billing starts next month); not the pending or suspended accounts.
    expect(next.drafts.count).toBe(3);
    await discardBillingDrafts(db, actorId, run(nextMonth));
  });
});

describe("finalizing", () => {
  it("numbers the drafts, posts a ledger debit on the invoice date and makes them unpaid", async () => {
    const result = await finalizeBilling(db, actorId, run(lastMonth));
    expect(result.finalizedNow).toBe(1);
    expect(result.firstNumber).toMatch(/^INV-\d{6}$/);
    expect(result.lastNumber).toBe(result.firstNumber);
    expect(result.skipped).toEqual([]);
    expect(result.drafts.count).toBe(0);
    expect(result.finalized).toEqual({ count: 1, totalCentavos: 249_900 });

    const [invoice] = await invoicesFor(ana.serviceId);
    expect(invoice).toMatchObject({ status: "unpaid", invoiceNumber: result.firstNumber });
    expect(invoice?.finalizedByUserId).toBe(actorId);

    const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.subscriberId, ana.subscriberId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entryType: "invoice",
      entryDate: `${lastMonth}-01`,
      reference: result.firstNumber,
      debitCentavos: 249_900,
      creditCentavos: 0,
      invoiceId: invoice!.id,
    });
    expect(await getSubscriberBalance(db, ana.subscriberId)).toBe(249_900);
    expect(await auditCount("invoice.finalize")).toBe(1);
    expect(await auditCount("billing.finalize")).toBe(1);
  });

  it("AT-11: after finalizing, generating again still creates no second invoice", async () => {
    const summary = await generateBillingDrafts(db, actorId, run(lastMonth));
    expect(summary.drafts.count).toBe(0);
    expect(await invoicesFor(ana.serviceId)).toHaveLength(1);
  });

  it("bills Ben a full month though he started mid-month, and charges Ana no second fee", async () => {
    const summary = await generateBillingDrafts(db, actorId, run(thisMonth));
    expect(summary.drafts).toEqual({ count: 2, totalCentavos: 99_900 + 45_000 });
    const benInvoice = (await invoicesFor(ben.serviceId))[0];
    expect(benInvoice?.totalCentavos).toBe(45_000);
    expect(benInvoice?.dueDate).toBe(`${thisMonth}-10`);
    expect(await invoicesFor(pendingServiceId)).toEqual([]);
    expect(await invoicesFor(suspendedServiceId)).toEqual([]);
    expect(await invoicesFor(futureServiceId)).toEqual([]);
  });

  it("discarding drafts lets a corrected rate be re-drafted", async () => {
    await changeServiceRate(
      db,
      actorId,
      ana.serviceId,
      serviceRateChangeSchema.parse({ rateCentavos: 89_900, reason: "Senior citizen discount" }),
    );
    // The draft keeps the rate it was made with.
    expect((await invoicesFor(ana.serviceId))[1]?.totalCentavos).toBe(99_900);

    const discardsBefore = await auditCount("billing.discard_drafts");
    const discarded = await discardBillingDrafts(db, actorId, run(thisMonth));
    expect(discarded.drafts.count).toBe(0);
    expect(await auditCount("billing.discard_drafts")).toBe(discardsBefore + 1);

    const regenerated = await generateBillingDrafts(db, actorId, run(thisMonth));
    expect(regenerated.drafts).toEqual({ count: 2, totalCentavos: 89_900 + 45_000 });
  });

  it("skips drafts of accounts suspended since generating, and numbers without gaps", async () => {
    await changeServiceStatus(
      db,
      actorId,
      ben.serviceId,
      serviceStatusChangeSchema.parse({ status: "suspended", reason: "Requested pause" }),
    );
    const previous = (await invoicesFor(ana.serviceId))[0]!.invoiceNumber!;

    const result = await finalizeBilling(db, actorId, run(thisMonth));
    expect(result.finalizedNow).toBe(1);
    expect(result.skipped).toEqual([expect.objectContaining({ accountStatus: "suspended" })]);
    expect(Number(result.firstNumber!.slice(4))).toBe(Number(previous.slice(4)) + 1);
    expect(result.drafts.count).toBe(1); // Ben's draft stays a draft

    await expect(finalizeBilling(db, actorId, run(thisMonth))).rejects.toMatchObject({
      code: "NOTHING_TO_FINALIZE",
      status: 409,
    });
  });

  it("refuses to finalize a month that was never generated", async () => {
    await expect(finalizeBilling(db, actorId, run("2020-01"))).rejects.toMatchObject({
      code: "PERIOD_NOT_GENERATED",
      status: 404,
    });
  });

  it("rolls everything back if finalizing fails part-way", async () => {
    // Break the number series so finalizing fails after the first lookups.
    await pool.query(`UPDATE document_sequences SET name = 'invoice_hidden' WHERE name = 'invoice'`);
    try {
      await generateBillingDrafts(db, actorId, run(nextMonth));
      const before = await getBillingSummary(db, nextMonth);
      await expect(finalizeBilling(db, actorId, run(nextMonth))).rejects.toThrow(/Document series not set up/);
      const after = await getBillingSummary(db, nextMonth);
      expect(after).toEqual(before);
      expect(after.finalized.count).toBe(0);
    } finally {
      await pool.query(`UPDATE document_sequences SET name = 'invoice' WHERE name = 'invoice_hidden'`);
      await discardBillingDrafts(db, actorId, run(nextMonth));
    }
  });
});

describe("reading invoices", () => {
  it("shows last month's open invoice as overdue and lists by filters", async () => {
    // Last month's invoice is always past due. This month's is too once its due day (the 5th) has passed.
    const today = await dbToday(db);
    const overdue = await listInvoices(db, invoiceListQuerySchema.parse({ status: "overdue" }));
    expect(overdue.items.every((i) => i.displayStatus === "overdue" && i.dueDate < today)).toBe(true);
    const lastMonthInvoice = overdue.items.find((i) => i.periodStart === `${lastMonth}-01`);
    expect(lastMonthInvoice).toMatchObject({ displayStatus: "overdue", balanceCentavos: 249_900 });
    expect(overdue.items.some((i) => i.periodStart === `${thisMonth}-01`)).toBe(today > `${thisMonth}-05`);

    const drafts = await listInvoices(db, invoiceListQuerySchema.parse({ status: "draft" }));
    expect(drafts.items.map((i) => i.subscriberName)).toEqual(["Ben Billing"]);

    const byPeriod = await listInvoices(db, invoiceListQuerySchema.parse({ period: thisMonth }));
    expect(byPeriod.total).toBe(2);

    const number = lastMonthInvoice!.invoiceNumber!;
    const searched = await listInvoices(db, invoiceListQuerySchema.parse({ search: number }));
    expect(searched.items.map((i) => i.invoiceNumber)).toEqual([number]);
  });

  it("returns an invoice with its lines", async () => {
    const [first] = await invoicesFor(ana.serviceId);
    const detail = await getInvoice(db, first!.id);
    expect(detail.planName).toBe("Internet 25 Mbps");
    expect(detail.items.map((i) => i.itemType)).toEqual(["subscription", "installation_fee"]);
  });
});

describe("the ledger", () => {
  it("runs a reproducible balance in date order", async () => {
    const ledger = await getSubscriberLedger(db, ana.subscriberId);
    expect(ledger.entries.map((e) => [e.debitCentavos, e.balanceCentavos])).toEqual([
      [249_900, 249_900],
      [89_900, 339_800],
    ]);
    expect(ledger.closingBalanceCentavos).toBe(339_800);
    expect(ledger.closingBalanceCentavos).toBe(await getSubscriberBalance(db, ana.subscriberId));
  });

  it("carries an opening balance into a date range", async () => {
    const ledger = await getSubscriberLedger(db, ana.subscriberId, { from: periodBounds(thisMonth).start });
    expect(ledger.openingBalanceCentavos).toBe(249_900);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.balanceCentavos).toBe(339_800);
  });
});

describe("voiding", () => {
  it("voids with a reason, credits the ledger and frees the month, fee included", async () => {
    const [first] = await invoicesFor(ana.serviceId);
    const voided = await voidInvoice(db, actorId, first!.id, { reason: "Billed before installation" });
    expect(voided).toMatchObject({ status: "void", displayStatus: "void", balanceCentavos: 0 });
    expect(voided.invoiceNumber).toBe(first!.invoiceNumber); // the number stays

    const ledger = await getSubscriberLedger(db, ana.subscriberId);
    expect(ledger.entries.at(-1)).toMatchObject({
      entryType: "invoice_void",
      reference: first!.invoiceNumber,
      creditCentavos: 249_900,
    });
    expect(ledger.closingBalanceCentavos).toBe(89_900);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "invoice.void"), eq(auditLogs.entityId, first!.id)));
    expect(audit[0]?.reason).toBe("Billed before installation");

    // The month can be billed again, and the voided fee is charged again.
    const summary = await generateBillingDrafts(db, actorId, run(lastMonth));
    expect(summary.drafts).toEqual({ count: 1, totalCentavos: 89_900 + 150_000 });
    await discardBillingDrafts(db, actorId, run(lastMonth));
  });

  it("refuses to void twice, to void a draft, or to void an invoice with payments", async () => {
    const [first, second] = await invoicesFor(ana.serviceId);
    await expect(voidInvoice(db, actorId, first!.id, { reason: "Again" })).rejects.toMatchObject({
      code: "INVOICE_ALREADY_VOID",
    });

    const benDraft = (await invoicesFor(ben.serviceId))[0]!;
    await expect(voidInvoice(db, actorId, benDraft.id, { reason: "Nope" })).rejects.toMatchObject({
      code: "INVOICE_IS_DRAFT",
    });

    // Payments arrive in Phase 5; simulate one being applied.
    await db.update(invoices).set({ paidCentavos: 10_000, status: "partially_paid" }).where(eq(invoices.id, second!.id));
    await expect(voidInvoice(db, actorId, second!.id, { reason: "Wrong" })).rejects.toMatchObject({
      code: "INVOICE_HAS_PAYMENTS",
      status: 409,
    });
  });
});

describe("archiving a subscriber with a balance", () => {
  it("is blocked until the balance is zero (termination itself is allowed)", async () => {
    const change = (status: string) =>
      changeSubscriberStatus(db, actorId, ana.subscriberId, subscriberStatusChangeSchema.parse({ status, reason: "Closing" }));
    await change("terminated");
    await expect(change("archived")).rejects.toMatchObject({ code: "OUTSTANDING_BALANCE", status: 409 });
  });
});
