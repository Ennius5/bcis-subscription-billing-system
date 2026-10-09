import { and, eq, sql } from "drizzle-orm";
import {
  addMonths,
  adjustmentCreateSchema,
  billingRunSchema,
  parsePesos,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
  type AdjustmentCreateInput,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbToday } from "../db/query_helpers";
import { adjustments, auditLogs, documentSequences, invoices, ledgerEntries } from "../db/schema";
import { getPaymentContext, getSubscriberCredit, postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { createAdjustment } from "./adjustments";
import { getSubscriberBalance } from "./ledger";
import { finalizeBilling, generateBillingDrafts, voidInvoice } from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let lastMonth: string;
let planId: string;

async function billedSubscriber(fullName: string): Promise<{ subscriberId: string; invoiceId: string }> {
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay: 5,
      address: { line1: "Purok 6", barangay: "Poblacion", city: "Maramag" },
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
  await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period: lastMonth }));
  await finalizeBilling(db, actorId, billingRunSchema.parse({ period: lastMonth }));
  const [invoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.subscriberId, subscriber.id), eq(invoices.serviceAccountId, service.id)));
  return { subscriberId: subscriber.id, invoiceId: invoice!.id };
}

function adjust(invoiceId: string, input: Partial<AdjustmentCreateInput> & Pick<AdjustmentCreateInput, "kind" | "amountCentavos">) {
  return createAdjustment(
    db,
    actorId,
    invoiceId,
    adjustmentCreateSchema.parse({
      category: input.kind === "credit" ? "service_outage" : "penalty",
      reason: "Adjustment test",
      ...input,
    }),
  );
}

const pay = (subscriberId: string, amount: string) =>
  postPayment(db, actorId, paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: parsePesos(amount) }));

async function loadInvoice(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row!;
}

/** Same invariant as the payment tests: the ledger agrees with invoices and unallocated credit. */
async function expectBalanced(subscriberId: string) {
  const rows = await db.select().from(invoices).where(eq(invoices.subscriberId, subscriberId));
  const open = rows
    .filter((i) => i.status !== "void" && i.status !== "draft")
    .reduce((sum, i) => sum + i.totalCentavos + i.adjustedCentavos - i.paidCentavos, 0);
  expect(await getSubscriberBalance(db, subscriberId)).toBe(open - (await getSubscriberCredit(db, subscriberId)));
}

async function adjustmentCounter(): Promise<number> {
  const [row] = await db.select().from(documentSequences).where(eq(documentSequences.name, "adjustment"));
  return row!.nextValue;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "adjust_actor", "Passw0rd!test", "administrator");
  lastMonth = addMonths(periodOf(await dbToday(db)), -1);
  planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-adj", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
});

afterAll(async () => {
  await pool.end();
});

describe("credit adjustments", () => {
  it("lower the balance, post a numbered ledger credit and are audited", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Outage Credit");

    const detail = await adjust(invoiceId, { kind: "credit", amountCentavos: parsePesos("200"), reason: "Outage Sept 3-5" });

    expect(detail).toMatchObject({ status: "unpaid", adjustedCentavos: -20_000, balanceCentavos: parsePesos("799") });
    expect(detail.adjustments).toHaveLength(1);
    expect(detail.adjustments[0]).toMatchObject({
      adjustmentNumber: expect.stringMatching(/^ADJ-\d{6}$/) as unknown,
      kind: "credit",
      category: "service_outage",
      amountCentavos: 20_000,
      reason: "Outage Sept 3-5",
    });
    // The billed total and lines never change.
    expect(detail.totalCentavos).toBe(99_900);

    const [line] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.reference, detail.adjustments[0]!.adjustmentNumber));
    expect(line).toMatchObject({ entryType: "adjustment", creditCentavos: 20_000, debitCentavos: 0, invoiceId });
    expect(await getSubscriberBalance(db, subscriberId)).toBe(parsePesos("799"));

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "invoice.adjust"), eq(auditLogs.entityId, invoiceId)));
    expect(audit).toMatchObject({ actorUserId: actorId, reason: "Outage Sept 3-5" });
    await expectBalanced(subscriberId);
  });

  it("make the invoice CREDITED when they cancel it in full, and it leaves the open invoices", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Fully Credited");

    const detail = await adjust(invoiceId, { kind: "credit", category: "billing_error", amountCentavos: 99_900 });

    expect(detail).toMatchObject({ status: "credited", displayStatus: "credited", balanceCentavos: 0 });
    expect((await getPaymentContext(db, subscriberId)).openInvoices).toHaveLength(0);
    expect(await getSubscriberBalance(db, subscriberId)).toBe(0);
    await expectBalanced(subscriberId);
  });

  it("leave a part-paid invoice PAID when they clear the rest", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Part Paid Credit");
    await pay(subscriberId, "500");

    const detail = await adjust(invoiceId, { kind: "credit", category: "goodwill", amountCentavos: parsePesos("499") });

    expect(detail).toMatchObject({ status: "paid", paidCentavos: 50_000, balanceCentavos: 0 });
    await expectBalanced(subscriberId);
  });

  it("cannot exceed the open balance, and a refused one uses no number and writes nothing", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Over Credit");
    await pay(subscriberId, "900");
    const counter = await adjustmentCounter();

    await expect(adjust(invoiceId, { kind: "credit", amountCentavos: parsePesos("100") })).rejects.toMatchObject({
      code: "ADJUSTMENT_NOT_ALLOWED",
      message: "A credit cannot be more than the open balance of ₱99.00.",
    });
    expect(await adjustmentCounter()).toBe(counter);
    expect(await db.select().from(adjustments).where(eq(adjustments.invoiceId, invoiceId))).toHaveLength(0);
    expect((await loadInvoice(invoiceId)).adjustedCentavos).toBe(0);
  });

  it("make later payments go by the adjusted balance", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Pays Adjusted");
    await adjust(invoiceId, { kind: "credit", amountCentavos: parsePesos("200") });

    const payment = await pay(subscriberId, "1000");

    expect(payment.allocations.map((a) => a.amountCentavos)).toEqual([parsePesos("799")]);
    expect(payment.creditCentavos).toBe(parsePesos("201"));
    expect((await loadInvoice(invoiceId)).status).toBe("paid");
    await expectBalanced(subscriberId);
  });
});

describe("debit adjustments", () => {
  it("add to what is owed and can reopen a paid invoice", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Debit Reopens");
    await pay(subscriberId, "999");

    const detail = await adjust(invoiceId, { kind: "debit", category: "reconnection_fee", amountCentavos: parsePesos("300") });

    expect(detail).toMatchObject({ status: "partially_paid", adjustedCentavos: 30_000, balanceCentavos: 30_000 });
    expect(await getSubscriberBalance(db, subscriberId)).toBe(30_000);
    await expectBalanced(subscriberId);
  });

  it("are paid straight away from the subscriber's credit", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Debit From Credit");
    await pay(subscriberId, "1500"); // 999 to the invoice, 501 credit

    const detail = await adjust(invoiceId, { kind: "debit", amountCentavos: parsePesos("100") });

    expect(detail.status).toBe("paid");
    expect(await getSubscriberCredit(db, subscriberId)).toBe(parsePesos("401"));
    await expectBalanced(subscriberId);
  });

  it("correct a wrong credit, with both kept on record", async () => {
    const { subscriberId, invoiceId } = await billedSubscriber("Corrected Credit");
    const credited = await adjust(invoiceId, { kind: "credit", category: "billing_error", amountCentavos: 99_900 });
    const number = credited.adjustments[0]!.adjustmentNumber;

    const detail = await adjust(invoiceId, {
      kind: "debit",
      category: "billing_error",
      amountCentavos: 99_900,
      reason: `Correction of ${number}`,
    });

    expect(detail).toMatchObject({ status: "unpaid", adjustedCentavos: 0, balanceCentavos: 99_900 });
    expect(detail.adjustments.map((a) => a.kind)).toEqual(["credit", "debit"]);
    await expectBalanced(subscriberId);
  });
});

describe("what cannot be adjusted", () => {
  it("drafts and void invoices", async () => {
    const { invoiceId } = await billedSubscriber("Void Then Adjust");
    await voidInvoice(db, actorId, invoiceId, { reason: "Wrong account" });
    await expect(adjust(invoiceId, { kind: "debit", amountCentavos: 100 })).rejects.toMatchObject({ code: "INVOICE_IS_VOID" });
    await expect(
      adjust("00000000-0000-4000-8000-000000000099", { kind: "debit", amountCentavos: 100 }),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
  });

  it("voiding is blocked once an invoice has adjustments", async () => {
    const { invoiceId } = await billedSubscriber("Adjusted Then Void");
    await adjust(invoiceId, { kind: "credit", amountCentavos: 100 });
    await expect(voidInvoice(db, actorId, invoiceId, { reason: "Try" })).rejects.toMatchObject({
      code: "INVOICE_HAS_ADJUSTMENTS",
    });
  });
});

describe("database rules", () => {
  it("keep adjustments append-only and their category matching their kind", async () => {
    const { invoiceId } = await billedSubscriber("Raw Adjust");
    const detail = await adjust(invoiceId, { kind: "credit", amountCentavos: 100 });
    const id = detail.adjustments[0]!.id;
    await expect(pool.query(`UPDATE adjustments SET amount_centavos = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM adjustments WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `INSERT INTO adjustments (adjustment_number, invoice_id, subscriber_id, kind, category, amount_centavos, reason, created_by_user_id)
         SELECT 'ADJ-RAW', id, subscriber_id, 'credit', 'penalty', 100, 'Raw insert', $2 FROM invoices WHERE id = $1`,
        [invoiceId, actorId],
      ),
    ).rejects.toThrow(/adjustments_category_valid/);
  });

  it("never let credits take an invoice below zero or a draft carry adjustments", async () => {
    const { invoiceId } = await billedSubscriber("Raw Invoice");
    await expect(
      pool.query(`UPDATE invoices SET adjusted_centavos = -100000, status = 'credited' WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow(/invoices_effective_total_nonneg|invoices_paid_range/);
    await expect(
      pool.query(`UPDATE invoices SET adjusted_centavos = -99900 WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow(/invoices_paid_status_consistent/);
  });
});
