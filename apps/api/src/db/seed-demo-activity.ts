import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  addMonths,
  adjustmentCreateSchema,
  batchCancelSchema,
  batchCloseSchema,
  batchCreateSchema,
  batchReconcileSchema,
  billingRunSchema,
  dueDateFor,
  fieldCollectionCreateSchema,
  gcashRejectSchema,
  gcashSubmissionCreateSchema,
  invoiceVoidSchema,
  paymentCreateSchema,
  paymentReverseSchema,
  periodBounds,
  periodOf,
  reconnectionAssignSchema,
  reconnectionCompleteSchema,
  reconnectionRequestSchema,
  remittanceCreateSchema,
  servicePlanChangeSchema,
  serviceRateChangeSchema,
  serviceStatusChangeSchema,
  serviceSuspendSchema,
  type CounterPaymentMethod,
} from "@bcis/shared";
import { createAdjustment } from "../billing/adjustments";
import { finalizeBilling, generateBillingDrafts, voidInvoice } from "../billing/service";
import { BatchError, cancelBatch, createBatch, dispatchBatch, submitBatch } from "../collection/batches";
import { recordFieldCollection, recordRemittance } from "../collection/field-collections";
import { closeBatch, reconcileBatch } from "../collection/reconciliation";
import { addSubmissionProof, createGcashSubmission, rejectGcashSubmission, verifyGcashSubmission } from "../payments/gcash";
import type { ProofStore } from "../payments/proof-storage";
import { postPayment, reversePayment } from "../payments/service";
import { assignReconnection, completeReconnection, requestReconnection, suspendService } from "../receivables/suspensions";
import { changeServicePlan, changeServiceRate, changeServiceStatus } from "../service-accounts/service";
import type { Db } from "./client";

/*
 * The money side of the demo dataset (spec section 8): the last three months and the current
 * one, replayed day by day through the normal services. Billing runs on the 1st, subscribers
 * pay around their due dates, services are terminated, suspended and reconnected on the day
 * it happened, and collectors go out with batches. Because every step is a real service call,
 * each record has its audit rows, receipt numbers follow the payment dates, and every
 * balance is what the system itself computed.
 *
 * What the dataset ends up showing:
 * - payments: exact, partial (P500 a month), advance (3 months up front, used as credit),
 *   one month late; cash, GCash (with proof), bank transfer, cheque and field collections
 * - overdue accounts in every aging bucket: some stopped paying 1, 2 or 3 months ago
 * - one payment keyed wrong, reversed and re-posted; one invoice voided at disconnection;
 *   one outage credit
 * - three suspensions for non-payment, two of them paid and reconnected (one fee waived)
 * - collector batches: balanced and closed, one closed with a P500 shortage, and the current
 *   month's still in the field (for the live demo)
 * - GCash: verified submissions, one rejected, the newest still waiting for verification
 */

/** How a subscriber pays. Assigned by position, so the same dataset comes out on every run. */
export type PayerProfile =
  | { kind: "regular" }
  | { kind: "late" } // always pays last month's bill
  | { kind: "partial" } // P500 a month, whatever is owed
  | { kind: "advance" } // three months up front, then regular
  | { kind: "stopped"; from: string } // regular until this month, then nothing
  | { kind: "suspended" } // never pays until the reconnection (if any)
  | { kind: "terminated" }; // regular until the month before the disconnection

/** Something that happens to a service on a given day (the stories from the account list). */
export type ServiceStory = "none" | "terminate" | "suspend" | "discount" | "upgrade";

export interface DemoService {
  id: string;
  planCode: string;
  story: ServiceStory;
}

export interface DemoSubscriber {
  index: number;
  id: string;
  fullName: string;
  mobile: string;
  billingDay: number;
  collectorCode: string;
  services: DemoService[];
}

export interface ActivityContext {
  db: Db;
  store: ProofStore;
  users: { admin: string; cashier: string; supervisor: string; technician: string };
  collectorIds: ReadonlyMap<string, string>;
  planPrices: ReadonlyMap<string, number>;
  planIds: ReadonlyMap<string, string>;
  subscribers: readonly DemoSubscriber[];
  rand: { int: (min: number, max: number) => number };
}

const PARTIAL_PAYMENT = 50_000;
const SHORTAGE = 50_000;
const TERMINATED_ON = 40; // days ago
const SUSPENDED_ON = 20;
const DISCOUNT_ON = 60;
const UPGRADE_ON = 45;
const RECONNECT_REQUESTED = 8;
const RECONNECT_COMPLETED = 6;
const GCASH_PENDING_WITHIN = 3; // submissions this recent are left for someone to verify

interface TimelineEvent {
  date: string;
  /** Same-day order: status changes, billing, adjustments, payments, batches, reconnections. */
  order: number;
  run: () => Promise<void>;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The synthetic GCash screenshot kept with the tests, found from wherever the seed runs. */
async function readProofImage(): Promise<Uint8Array> {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, "tests", "fixtures", "sample-proof.png");
    if (existsSync(candidate)) return readFile(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("tests/fixtures/sample-proof.png not found (run the seed inside the repository)");
    dir = parent;
  }
}

export function profileFor(subscriber: DemoSubscriber, periods: readonly string[]): PayerProfile {
  if (subscriber.services.some((s) => s.story === "suspend")) return { kind: "suspended" };
  if (subscriber.services.some((s) => s.story === "terminate")) return { kind: "terminated" };
  switch (subscriber.index % 10) {
    case 6:
      return { kind: "partial" };
    case 7:
      // Five subscribers: stopped paying three, two and one month(s) before the current one.
      return { kind: "stopped", from: periods[Math.floor(subscriber.index / 10) % 3]! };
    case 8:
      return { kind: "late" };
    case 9:
      return { kind: "advance" };
    default:
      return { kind: "regular" };
  }
}

export async function seedActivity(ctx: ActivityContext): Promise<void> {
  const { db, users } = ctx;
  const today = await scalar<string>(db, sql`SELECT CURRENT_DATE::text AS v`);
  const current = periodOf(today);
  const periods = [-3, -2, -1, 0].map((n) => addMonths(current, n));
  const [p0, p1, p2, p3] = periods as [string, string, string, string];
  const daysAgo = (n: number) => addDays(today, -n);
  const proof = await readProofImage();

  const events: TimelineEvent[] = [];
  const at = (date: string, order: number, run: () => Promise<void>) => {
    if (date <= today) events.push({ date, order, run });
  };
  const tally = {
    payments: 0,
    gcashVerified: 0,
    gcashPending: 0,
    gcashRejected: 0,
    fieldCollections: 0,
    batches: 0,
    reversals: 0,
    reconnections: 0,
  };

  /* ------------------------------- Amounts owed ------------------------------- */

  /** What is still unpaid on the subscriber's posted invoices, for one month or all of them. */
  const owed = (subscriberId: string, period?: string) =>
    scalar<number>(
      db,
      sql`SELECT coalesce(sum(total_centavos + adjusted_centavos - paid_centavos), 0)::int AS v
          FROM invoices
          WHERE subscriber_id = ${subscriberId} AND status NOT IN ('draft', 'void')
            ${period ? sql`AND period_start = ${periodBounds(period).start}` : sql``}`,
    );

  /** What this subscriber hands over for the month, by how they pay. */
  async function amountFor(subscriber: DemoSubscriber, profile: PayerProfile, period: string): Promise<number> {
    switch (profile.kind) {
      case "regular":
        return owed(subscriber.id, period);
      case "late":
        return period === p0 ? 0 : owed(subscriber.id, addMonths(period, -1));
      case "partial":
        return Math.min(PARTIAL_PAYMENT, await owed(subscriber.id));
      case "advance":
        return period === p0 ? 3 * (await owed(subscriber.id, period)) : owed(subscriber.id, period);
      case "stopped":
        return period < profile.from ? owed(subscriber.id, period) : 0;
      case "terminated": {
        const stopsFrom = addMonths(periodOf(daysAgo(TERMINATED_ON)), -1);
        return period < stopsFrom ? owed(subscriber.id, period) : 0;
      }
      case "suspended":
        return 0;
    }
  }

  /* -------------------------------- Billing -------------------------------- */

  for (const period of periods) {
    at(periodBounds(period).start, 1, async () => {
      await generateBillingDrafts(db, users.admin, billingRunSchema.parse({ period }));
      await finalizeBilling(db, users.admin, billingRunSchema.parse({ period }));
    });
  }

  /* ----------------------------- Service stories ----------------------------- */

  let voided = false;
  const suspended: Array<{ subscriber: DemoSubscriber; serviceId: string }> = [];
  for (const subscriber of ctx.subscribers) {
    for (const service of subscriber.services) {
      if (service.story === "terminate") {
        at(daysAgo(TERMINATED_ON), 0, async () => {
          await changeServiceStatus(
            db,
            users.admin,
            service.id,
            serviceStatusChangeSchema.parse({ status: "terminated", effectiveDate: daysAgo(TERMINATED_ON), reason: "Moved away" }),
          );
          // The first one asked to disconnect before the last bill went out: that bill is voided.
          if (voided) return;
          const last = await scalar<string | null>(
            db,
            sql`SELECT id::text AS v FROM invoices
                WHERE service_account_id = ${service.id} AND status NOT IN ('draft', 'void') AND paid_centavos = 0
                ORDER BY period_start DESC LIMIT 1`,
          );
          if (last) {
            await voidInvoice(
              db,
              users.admin,
              last,
              invoiceVoidSchema.parse({ reason: "Disconnection was requested before this month; keyed late. Owner approved." }),
            );
            voided = true;
          }
        });
      } else if (service.story === "suspend") {
        suspended.push({ subscriber, serviceId: service.id });
        at(daysAgo(SUSPENDED_ON), 0, async () => {
          await suspendService(
            db,
            users.admin,
            service.id,
            serviceSuspendSchema.parse({ reason: "Unpaid balance", effectiveDate: daysAgo(SUSPENDED_ON), approvedBy: "Owner" }),
          );
        });
      } else if (service.story === "discount") {
        at(daysAgo(DISCOUNT_ON), 0, async () => {
          await changeServiceRate(
            db,
            users.admin,
            service.id,
            serviceRateChangeSchema.parse({
              rateCentavos: ctx.planPrices.get(service.planCode)! - 10_000,
              reason: "Senior citizen discount",
              effectiveDate: daysAgo(DISCOUNT_ON),
            }),
          );
        });
      } else if (service.story === "upgrade") {
        at(daysAgo(UPGRADE_ON), 0, async () => {
          await changeServicePlan(
            db,
            users.admin,
            service.id,
            servicePlanChangeSchema.parse({
              planId: ctx.planIds.get("INET-50"),
              reason: "Upgrade request",
              effectiveDate: daysAgo(UPGRADE_ON),
            }),
          );
        });
      }
    }
  }

  /* -------------------------------- Payments -------------------------------- */

  // Every fourth subscriber pays the collector; areas go round by three, so both collectors get some.
  const fieldPayer = (s: DemoSubscriber, period: string) => s.index % 4 === 1 && period !== p0;
  const gcashPayer = (s: DemoSubscriber) => s.index % 7 === 3;
  const counterMethod = (s: DemoSubscriber): CounterPaymentMethod =>
    s.index % 11 === 5 ? "bank_transfer" : s.index % 13 === 8 ? "cheque" : "cash";

  let gcashSeq = 0;
  let reversalDone = false;
  let rejectionDone = false;

  async function payAtCounter(subscriber: DemoSubscriber, amount: number, date: string, period: string) {
    const method = counterMethod(subscriber);
    const referenceNumber =
      method === "bank_transfer" ? `BT-${date.replaceAll("-", "")}-${subscriber.index}` : method === "cheque" ? `CHK-${100200 + tally.payments}` : null;
    const post = (amountCentavos: number) =>
      postPayment(
        db,
        users.cashier,
        paymentCreateSchema.parse({ subscriberId: subscriber.id, method, amountCentavos, paymentDate: date, referenceNumber }),
      );

    // Once, in the month before this one: the cashier keys an extra zero, notices, reverses it
    // and posts the right amount (spec: reversal keeps the original visible, with a reason).
    if (!reversalDone && period === p2 && method === "cash") {
      reversalDone = true;
      const wrong = await post(amount * 10);
      await reversePayment(
        db,
        users.admin,
        wrong.id,
        paymentReverseSchema.parse({ reason: "Amount keyed with an extra zero; reposted with the correct amount" }),
      );
      tally.reversals++;
    }
    await post(amount);
    tally.payments++;
  }

  async function payByGcash(subscriber: DemoSubscriber, amount: number, date: string, period: string) {
    const submit = (amountCentavos: number) => {
      gcashSeq++;
      return createGcashSubmission(
        db,
        users.cashier,
        gcashSubmissionCreateSchema.parse({
          subscriberId: subscriber.id,
          referenceNumber: String(9_016_000_000_000 + gcashSeq * 7_919),
          senderName: subscriber.fullName,
          senderNumber: subscriber.mobile,
          amountCentavos,
          transactionDate: date,
        }),
      );
    };
    const withProof = async (amountCentavos: number) => {
      const submission = await submit(amountCentavos);
      await addSubmissionProof(db, ctx.store, users.cashier, submission.id, { bytes: proof, filename: "gcash-receipt.png" });
      return submission;
    };

    // Once: the amount typed in does not match the screenshot, so the reviewer rejects it.
    if (!rejectionDone && period === p2) {
      rejectionDone = true;
      const wrong = await withProof(amount + 10_000);
      await rejectGcashSubmission(
        db,
        users.admin,
        wrong.id,
        gcashRejectSchema.parse({ reason: "Amount does not match the screenshot; asked the customer to resend" }),
      );
      tally.gcashRejected++;
    }

    const submission = await withProof(amount);
    if (date > daysAgo(GCASH_PENDING_WITHIN)) {
      tally.gcashPending++; // left for the live demo: verify it, then try the same reference again
      return;
    }
    await verifyGcashSubmission(db, users.admin, submission.id);
    tally.gcashVerified++;
  }

  for (const subscriber of ctx.subscribers) {
    const profile = profileFor(subscriber, periods);
    for (const period of periods) {
      if (fieldPayer(subscriber, period)) continue; // the collector picks it up (batches below)
      const due = dueDateFor(period, subscriber.billingDay);
      const date = [addDays(due, -ctx.rand.int(0, 6)), addDays(periodBounds(period).start, 1)].toSorted().at(-1)!;
      at(date, 3, async () => {
        const amount = await amountFor(subscriber, profile, period);
        if (amount <= 0) return;
        if (gcashPayer(subscriber)) await payByGcash(subscriber, amount, date, period);
        else await payAtCounter(subscriber, amount, date, period);
      });
    }
  }

  /* --------------------------------- Batches --------------------------------- */

  type Outcome = "balanced" | "short" | "in_field";
  const batchPlan: Array<{ period: string; date: string; outcomes: Record<string, Outcome> }> = [
    { period: p1, date: `${p1}-18`, outcomes: { "COL-01": "balanced", "COL-02": "balanced" } },
    { period: p2, date: `${p2}-18`, outcomes: { "COL-01": "balanced", "COL-02": "short" } },
    { period: p3, date: [`${p3}-08`, daysAgo(1)].toSorted()[0]!, outcomes: { "COL-01": "in_field", "COL-02": "in_field" } },
  ];
  let receiptSeq = 4100;

  for (const { period, date, outcomes } of batchPlan) {
    if (date < periodBounds(period).start) continue; // too early in the month to have gone out yet
    for (const [code, outcome] of Object.entries(outcomes)) {
      at(date, 4, async () => {
        const { batch } = await createBatch(
          db,
          users.supervisor,
          batchCreateSchema.parse({ collectorId: ctx.collectorIds.get(code), collectionDate: date }),
        );
        tally.batches++;
        await dispatchBatch(db, users.supervisor, batch.id);

        let cash = 0;
        for (const subscriber of ctx.subscribers) {
          if (subscriber.collectorCode !== code || !fieldPayer(subscriber, period)) continue;
          const amount = await amountFor(subscriber, profileFor(subscriber, periods), period);
          if (amount <= 0) continue;
          try {
            await recordFieldCollection(
              db,
              users.supervisor,
              batch.id,
              fieldCollectionCreateSchema.parse({
                subscriberId: subscriber.id,
                method: "cash",
                amountCentavos: amount,
                paymentDate: date,
                referenceNumber: `CR-${receiptSeq++}`,
              }),
            );
            cash += amount;
            tally.fieldCollections++;
          } catch (err) {
            if (!(err instanceof BatchError && err.code === "NOT_ON_BATCH")) throw err;
          }
        }

        if (outcome === "in_field") return; // still out: submit, remit and reconcile in the demo
        if (cash === 0) {
          await cancelBatch(db, users.supervisor, batch.id, batchCancelSchema.parse({ reason: "Nothing was collected" }));
          return;
        }
        await submitBatch(db, users.supervisor, batch.id);
        const remitted = outcome === "short" ? Math.max(cash - SHORTAGE, 1) : cash;
        await recordRemittance(db, users.supervisor, batch.id, remittanceCreateSchema.parse({ amountCentavos: remitted }));
        const differenceCentavos = remitted - cash;
        await reconcileBatch(
          db,
          users.supervisor,
          batch.id,
          batchReconcileSchema.parse({
            differenceCentavos,
            varianceReason: differenceCentavos === 0 ? null : "Collector short; will be deducted from the next payout",
          }),
        );
        await closeBatch(db, users.admin, batch.id, batchCloseSchema.parse({ differenceCentavos }));
      });
    }
  }

  /* -------------------------------- Adjustment -------------------------------- */

  // An area-wide outage early last month: one subscriber gets a rebate before paying (due
  // mid-month, so the bill is still open on the 5th).
  const rebated = ctx.subscribers.find(
    (s) =>
      profileFor(s, periods).kind === "regular" &&
      s.services.length > 0 &&
      !fieldPayer(s, p2) &&
      !gcashPayer(s) &&
      s.billingDay >= 15,
  );
  if (rebated) {
    at(`${p2}-05`, 2, async () => {
      const invoiceId = await scalar<string | null>(
        db,
        sql`SELECT id::text AS v FROM invoices
            WHERE subscriber_id = ${rebated.id} AND period_start = ${periodBounds(p2).start} AND status NOT IN ('draft', 'void')
            LIMIT 1`,
      );
      if (!invoiceId) return;
      await createAdjustment(
        db,
        users.admin,
        invoiceId,
        adjustmentCreateSchema.parse({
          kind: "credit",
          category: "service_outage",
          amountCentavos: 15_000,
          reason: "Internet outage on the 3rd and 4th (area-wide)",
        }),
      );
    });
  }

  /* ------------------------------- Reconnections ------------------------------- */

  // Two of the suspended subscribers settle everything and are reconnected; the third still owes.
  for (const [n, { subscriber, serviceId }] of suspended.slice(0, 2).entries()) {
    let reconnectionId = "";
    at(daysAgo(RECONNECT_REQUESTED), 5, async () => {
      const amount = await owed(subscriber.id);
      if (amount > 0) await payAtCounter(subscriber, amount, daysAgo(RECONNECT_REQUESTED), p3);
      const waived = n === 1;
      const request = await requestReconnection(
        db,
        users.admin,
        serviceId,
        reconnectionRequestSchema.parse({
          requestDate: daysAgo(RECONNECT_REQUESTED),
          waiveFee: waived,
          ...(waived ? { feeWaiverReason: "Subscriber since 2019; owner waived the fee" } : {}),
        }),
      );
      reconnectionId = request.id;
      await assignReconnection(db, users.admin, request.id, reconnectionAssignSchema.parse({ technicianUserId: users.technician }));
    });
    at(daysAgo(RECONNECT_COMPLETED), 5, async () => {
      await completeReconnection(
        db,
        users.technician,
        reconnectionId,
        reconnectionCompleteSchema.parse({ completionDate: daysAgo(RECONNECT_COMPLETED) }),
      );
      tally.reconnections++;
    });
  }

  /* ---------------------------------- Replay ---------------------------------- */

  // Stable sort: same day and order keep the order they were added in.
  const ordered = events.toSorted((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  for (const event of ordered) await event.run();

  const invoices = await scalar<number>(db, sql`SELECT count(*)::int AS v FROM invoices WHERE status <> 'draft'`);
  const overdue = await scalar<number>(
    db,
    sql`SELECT count(DISTINCT subscriber_id)::int AS v FROM invoices
        WHERE status NOT IN ('draft', 'void') AND paid_centavos < total_centavos + adjusted_centavos AND due_date < CURRENT_DATE`,
  );
  console.log(
    `Billed ${periods.join(", ")}: ${invoices} invoices. Payments: ${tally.payments} at the counter, ` +
      `${tally.fieldCollections} field collections in ${tally.batches} batches, ${tally.gcashVerified} GCash verified ` +
      `(${tally.gcashPending} waiting, ${tally.gcashRejected} rejected), ${tally.reversals} reversal. ` +
      `${tally.reconnections} reconnections. ${overdue} subscribers have overdue bills.`,
  );
}

async function scalar<T>(db: Db, query: ReturnType<typeof sql>): Promise<T> {
  const result = await db.execute<{ v: T }>(query);
  return (result.rows[0]?.v ?? null) as T;
}
