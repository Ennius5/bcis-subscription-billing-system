import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  allocateOldestFirst,
  invoiceDisplayStatus,
  invoicePaymentStatus,
  planManualAllocation,
  type AllocationPlan,
  type AllocationSource,
  type ManualAllocationRequest,
  type OpenInvoice,
  type PaymentCreateInput,
  type PaymentListQuery,
  type PaymentMethod,
  type PaymentReverseInput,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { takeDocumentNumbers } from "../db/document-numbers";
import { getSubscriberBalance } from "../billing/ledger";
import { dbToday, likePattern, type Tx } from "../db/query_helpers";
import {
  gcashSubmissions,
  invoices,
  ledgerEntries,
  paymentAllocations,
  paymentReversals,
  payments,
  serviceAccounts,
  subscribers,
  users,
} from "../db/schema";

export class PaymentError extends Error {
  constructor(
    public readonly code:
      | "SUBSCRIBER_NOT_FOUND"
      | "SUBSCRIBER_ARCHIVED"
      | "PAYMENT_DATE_IN_FUTURE"
      | "ALLOCATION_INVALID"
      | "PAYMENT_NOT_FOUND"
      | "PAYMENT_ALREADY_REVERSED",
    public readonly status: number,
    message: string,
    /** For ALLOCATION_INVALID: the invoice the problem is about, so the form can mark it. */
    public readonly invoiceId?: string,
  ) {
    super(message);
  }
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  gcash: "GCash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  other: "Other",
};

/* ------------------------------ Locking ------------------------------ */

/**
 * Every money operation for a subscriber (post, reverse, apply credit) locks the subscriber
 * row first, so two PCs working on the same subscriber take turns instead of both reading
 * the same open balance (AT-09). Different subscribers do not block each other.
 */
async function lockSubscriber(tx: Tx, subscriberId: string) {
  const [row] = await tx
    .select({ id: subscribers.id, status: subscribers.status, accountNumber: subscribers.accountNumber })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .for("update");
  return row ?? null;
}

interface InvoiceAmounts {
  totalCentavos: number;
  paidCentavos: number;
  adjustedCentavos: number;
}

/** What is still owed: the effective total (billed total plus adjustments) minus payments. */
const balanceOf = (i: InvoiceAmounts) => i.totalCentavos + i.adjustedCentavos - i.paidCentavos;

type LockedInvoice = OpenInvoice & InvoiceAmounts;

/** The subscriber's finalized invoices that still have a balance, oldest first, locked. */
async function lockOpenInvoices(tx: Tx, subscriberId: string): Promise<LockedInvoice[]> {
  const rows = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      totalCentavos: invoices.totalCentavos,
      paidCentavos: invoices.paidCentavos,
      adjustedCentavos: invoices.adjustedCentavos,
    })
    .from(invoices)
    .where(
      sql`${invoices.subscriberId} = ${subscriberId} AND ${invoices.status} IN ('unpaid', 'partially_paid')`,
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber))
    .for("update");
  return rows.map((r) => ({
    ...r,
    invoiceNumber: r.invoiceNumber!, // finalized invoices always have a number
    balanceCentavos: balanceOf(r),
  }));
}

/**
 * Writes a plan's allocations: one allocation row per line and the new paid amount and
 * status on each invoice. `invoicesById` must hold the locked rows the plan was made from.
 */
async function applyPlan(
  tx: Tx,
  actorUserId: string,
  paymentId: string,
  subscriberId: string,
  plan: AllocationPlan,
  source: AllocationSource,
  invoicesById: Map<string, InvoiceAmounts>,
): Promise<void> {
  if (plan.lines.length === 0) return;
  await tx.insert(paymentAllocations).values(
    plan.lines.map((line) => ({
      paymentId,
      invoiceId: line.invoiceId,
      subscriberId,
      amountCentavos: line.amountCentavos,
      source,
      allocatedByUserId: actorUserId,
    })),
  );
  for (const line of plan.lines) {
    const invoice = invoicesById.get(line.invoiceId)!;
    const paid = invoice.paidCentavos + line.amountCentavos;
    await tx
      .update(invoices)
      .set({ paidCentavos: paid, status: invoicePaymentStatus(invoice.totalCentavos, paid, invoice.adjustedCentavos) })
      .where(eq(invoices.id, line.invoiceId));
    invoice.paidCentavos = paid; // later plans in the same transaction see the new balance
  }
}

const planSummary = (plan: AllocationPlan) =>
  plan.lines.map((l) => ({ invoiceNumber: l.invoiceNumber, amountCentavos: l.amountCentavos }));

/* ------------------------------- Posting ------------------------------- */

/** What postPaymentInTx needs; GCash verification (step 4) passes its submission too. */
export interface PostPaymentData {
  subscriberId: string;
  method: PaymentMethod;
  amountCentavos: number;
  paymentDate?: string;
  referenceNumber?: string | null;
  notes?: string | null;
  allocations?: ManualAllocationRequest[];
  gcashSubmissionId?: string;
}

/**
 * Posts a payment inside the caller's transaction: takes the next receipt number, credits
 * the full amount to the ledger, pays the open invoices (oldest first, or as chosen by an
 * authorized user) and keeps any remainder as credit. Whether the caller may choose the
 * allocation (payment.allocate) is checked by the route, not here.
 */
export async function postPaymentInTx(tx: Tx, actorUserId: string, data: PostPaymentData): Promise<string> {
  const subscriber = await lockSubscriber(tx, data.subscriberId);
  if (!subscriber) throw new PaymentError("SUBSCRIBER_NOT_FOUND", 404, "Subscriber not found.");
  if (subscriber.status === "archived") {
    throw new PaymentError("SUBSCRIBER_ARCHIVED", 409, `Subscriber ${subscriber.accountNumber} is archived.`);
  }

  const today = await dbToday(tx);
  const paymentDate = data.paymentDate ?? today;
  if (paymentDate > today) {
    throw new PaymentError("PAYMENT_DATE_IN_FUTURE", 422, "The payment date cannot be in the future.");
  }

  const open = await lockOpenInvoices(tx, data.subscriberId);
  let plan: AllocationPlan;
  if (data.allocations) {
    const result = planManualAllocation(data.amountCentavos, data.allocations, open);
    if (!result.ok) throw new PaymentError("ALLOCATION_INVALID", 422, result.problem, result.invoiceId);
    plan = result.plan;
  } else {
    plan = allocateOldestFirst(data.amountCentavos, open);
  }

  const [receiptNumber] = await takeDocumentNumbers(tx, "receipt", 1);
  const [payment] = await tx
    .insert(payments)
    .values({
      receiptNumber: receiptNumber!,
      subscriberId: data.subscriberId,
      method: data.method,
      amountCentavos: data.amountCentavos,
      allocatedCentavos: data.amountCentavos - plan.creditCentavos,
      paymentDate,
      referenceNumber: data.referenceNumber || null,
      notes: data.notes || null,
      gcashSubmissionId: data.gcashSubmissionId ?? null,
      receivedByUserId: actorUserId,
    })
    .returning({ id: payments.id });
  const paymentId = payment!.id;

  await applyPlan(
    tx,
    actorUserId,
    paymentId,
    data.subscriberId,
    plan,
    data.allocations ? "manual" : "auto",
    new Map(open.map((i) => [i.id, i])),
  );

  const label = METHOD_LABELS[data.method];
  await tx.insert(ledgerEntries).values({
    subscriberId: data.subscriberId,
    entryDate: paymentDate,
    entryType: "payment",
    reference: receiptNumber!,
    description: data.referenceNumber ? `${label} payment (ref ${data.referenceNumber})` : `${label} payment`,
    creditCentavos: data.amountCentavos,
    paymentId,
    createdByUserId: actorUserId,
  });

  await writeAudit(tx, {
    actorUserId,
    action: "payment.post",
    entityType: "payment",
    entityId: paymentId,
    newValues: {
      receiptNumber,
      subscriberId: data.subscriberId,
      method: data.method,
      amountCentavos: data.amountCentavos,
      paymentDate,
      allocation: data.allocations ? "manual" : "auto",
      allocations: planSummary(plan),
      creditCentavos: plan.creditCentavos,
    },
  });

  return paymentId;
}

/** Receive Payment at the counter (Cash, bank transfer, cheque, other). */
export async function postPayment(db: Db, actorUserId: string, input: PaymentCreateInput): Promise<PaymentDetail> {
  return db.transaction(async (tx) => {
    const id = await postPaymentInTx(tx, actorUserId, input);
    return fetchPayment(tx, id);
  });
}

/* ------------------------------- Credit ------------------------------- */

/**
 * Applies the subscriber's credit (the unallocated part of earlier payments) to their open
 * invoices, oldest credit to oldest invoice first (AT-03). Runs after billing is finalized
 * and after a reversal reopens invoices. No ledger entry: the money was credited when it
 * was received; this only records which invoices it paid. Returns the amount applied.
 */
export async function applyAvailableCredit(tx: Tx, actorUserId: string, subscriberId: string): Promise<number> {
  if (!(await lockSubscriber(tx, subscriberId))) return 0;

  const withCredit = await tx
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCentavos: payments.amountCentavos,
      allocatedCentavos: payments.allocatedCentavos,
    })
    .from(payments)
    .where(
      and(
        eq(payments.subscriberId, subscriberId),
        eq(payments.status, "posted"),
        lt(payments.allocatedCentavos, payments.amountCentavos),
      ),
    )
    .orderBy(asc(payments.paymentDate), asc(payments.postedAt))
    .for("update");
  if (withCredit.length === 0) return 0;

  let open = await lockOpenInvoices(tx, subscriberId);
  const invoicesById = new Map(open.map((i) => [i.id, i]));
  let applied = 0;

  for (const payment of withCredit) {
    if (open.length === 0) break;
    const plan = allocateOldestFirst(payment.amountCentavos - payment.allocatedCentavos, open);
    if (plan.lines.length === 0) continue;

    await applyPlan(tx, actorUserId, payment.id, subscriberId, plan, "credit", invoicesById);
    const amount = plan.lines.reduce((sum, l) => sum + l.amountCentavos, 0);
    await tx
      .update(payments)
      .set({ allocatedCentavos: payment.allocatedCentavos + amount })
      .where(eq(payments.id, payment.id));
    await writeAudit(tx, {
      actorUserId,
      action: "payment.apply_credit",
      entityType: "payment",
      entityId: payment.id,
      oldValues: { allocatedCentavos: payment.allocatedCentavos },
      newValues: {
        receiptNumber: payment.receiptNumber,
        allocatedCentavos: payment.allocatedCentavos + amount,
        allocations: planSummary(plan),
      },
    });
    applied += amount;
    open = [...invoicesById.values()]
      .filter((i) => balanceOf(i) > 0)
      .map((i) => ({ ...i, balanceCentavos: balanceOf(i) }));
  }
  return applied;
}

/** The subscriber's unallocated payment money (shown as "Credit balance"). */
export async function getSubscriberCredit(executor: DbOrTx, subscriberId: string): Promise<number> {
  const result = await executor.execute<{ credit: string }>(sql`
    SELECT coalesce(sum(amount_centavos - allocated_centavos), 0)::bigint AS credit
    FROM payments WHERE subscriber_id = ${subscriberId} AND status = 'posted'
  `);
  return Number(result.rows[0]?.credit ?? 0);
}

/* ------------------------------- Reversal ------------------------------- */

/**
 * Reverses a posted payment (AT-06). The payment, its receipt number and its allocations
 * stay as history; the payment is marked reversed, its invoices get their balances back,
 * the ledger gets a debit that cancels the original credit, and a GCash submission it came
 * from is marked reversed (which frees its reference). Any other credit the subscriber has
 * is then applied to the reopened invoices.
 */
export async function reversePayment(
  db: Db,
  actorUserId: string,
  paymentId: string,
  input: PaymentReverseInput,
): Promise<PaymentDetail> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ subscriberId: payments.subscriberId })
      .from(payments)
      .where(eq(payments.id, paymentId));
    if (!found) throw new PaymentError("PAYMENT_NOT_FOUND", 404, "Payment not found.");
    await lockSubscriber(tx, found.subscriberId);

    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!payment) throw new PaymentError("PAYMENT_NOT_FOUND", 404, "Payment not found.");
    if (payment.status === "reversed") {
      throw new PaymentError("PAYMENT_ALREADY_REVERSED", 409, `Payment ${payment.receiptNumber} is already reversed.`);
    }

    // What this payment paid, per invoice (credit applied later included).
    const paid = await tx
      .select({
        invoiceId: paymentAllocations.invoiceId,
        amountCentavos: sql<number>`sum(${paymentAllocations.amountCentavos})::int`,
      })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId))
      .groupBy(paymentAllocations.invoiceId);

    const undone: Array<{ invoiceNumber: string; amountCentavos: number }> = [];
    for (const { invoiceId, amountCentavos } of paid) {
      const [invoice] = await tx
        .select({
          invoiceNumber: invoices.invoiceNumber,
          totalCentavos: invoices.totalCentavos,
          paidCentavos: invoices.paidCentavos,
          adjustedCentavos: invoices.adjustedCentavos,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for("update");
      const remaining = invoice!.paidCentavos - amountCentavos;
      await tx
        .update(invoices)
        .set({
          paidCentavos: remaining,
          status: invoicePaymentStatus(invoice!.totalCentavos, remaining, invoice!.adjustedCentavos),
        })
        .where(eq(invoices.id, invoiceId));
      undone.push({ invoiceNumber: invoice!.invoiceNumber!, amountCentavos });
    }

    await tx.update(payments).set({ status: "reversed" }).where(eq(payments.id, paymentId));
    await tx.insert(paymentReversals).values({ paymentId, reason: input.reason, reversedByUserId: actorUserId });
    if (payment.gcashSubmissionId) {
      await tx
        .update(gcashSubmissions)
        .set({ status: "reversed" })
        .where(eq(gcashSubmissions.id, payment.gcashSubmissionId));
    }
    await tx.insert(ledgerEntries).values({
      subscriberId: payment.subscriberId,
      entryDate: await dbToday(tx),
      entryType: "payment_reversal",
      reference: payment.receiptNumber,
      description: `Reversal of ${payment.receiptNumber}: ${input.reason}`,
      debitCentavos: payment.amountCentavos,
      paymentId,
      createdByUserId: actorUserId,
    });

    await writeAudit(tx, {
      actorUserId,
      action: "payment.reverse",
      entityType: "payment",
      entityId: paymentId,
      reason: input.reason,
      oldValues: { status: "posted" },
      newValues: {
        status: "reversed",
        receiptNumber: payment.receiptNumber,
        amountCentavos: payment.amountCentavos,
        unallocated: undone,
      },
    });

    await applyAvailableCredit(tx, actorUserId, payment.subscriberId);
    return fetchPayment(tx, paymentId);
  });
}

/* ------------------------------- Reading ------------------------------- */

export interface PaymentDetail {
  id: string;
  receiptNumber: string;
  status: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  method: string;
  amountCentavos: number;
  allocatedCentavos: number;
  /** Unallocated money still available as credit (0 once reversed). */
  creditCentavos: number;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  gcashSubmissionId: string | null;
  receivedByName: string;
  postedAt: Date;
  allocations: Array<{
    invoiceId: string;
    invoiceNumber: string;
    serviceNumber: string;
    periodStart: string;
    amountCentavos: number;
    source: string;
    allocatedAt: Date;
  }>;
  reversal: { reason: string; reversedAt: Date; reversedByName: string } | null;
}

async function fetchPayment(executor: DbOrTx, paymentId: string): Promise<PaymentDetail> {
  const [row] = await executor
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      status: payments.status,
      subscriberId: payments.subscriberId,
      accountNumber: subscribers.accountNumber,
      subscriberName: subscribers.fullName,
      method: payments.method,
      amountCentavos: payments.amountCentavos,
      allocatedCentavos: payments.allocatedCentavos,
      paymentDate: payments.paymentDate,
      referenceNumber: payments.referenceNumber,
      notes: payments.notes,
      gcashSubmissionId: payments.gcashSubmissionId,
      receivedByName: users.fullName,
      postedAt: payments.postedAt,
    })
    .from(payments)
    .innerJoin(subscribers, eq(subscribers.id, payments.subscriberId))
    .innerJoin(users, eq(users.id, payments.receivedByUserId))
    .where(eq(payments.id, paymentId));
  if (!row) throw new PaymentError("PAYMENT_NOT_FOUND", 404, "Payment not found.");

  const allocations = await executor
    .select({
      invoiceId: paymentAllocations.invoiceId,
      invoiceNumber: sql<string>`${invoices.invoiceNumber}`,
      serviceNumber: serviceAccounts.serviceNumber,
      periodStart: invoices.periodStart,
      amountCentavos: paymentAllocations.amountCentavos,
      source: paymentAllocations.source,
      allocatedAt: paymentAllocations.allocatedAt,
    })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, invoices.serviceAccountId))
    .where(eq(paymentAllocations.paymentId, paymentId))
    .orderBy(asc(paymentAllocations.allocatedAt), asc(invoices.dueDate), asc(invoices.invoiceNumber));

  const [reversal] = await executor
    .select({
      reason: paymentReversals.reason,
      reversedAt: paymentReversals.reversedAt,
      reversedByName: users.fullName,
    })
    .from(paymentReversals)
    .innerJoin(users, eq(users.id, paymentReversals.reversedByUserId))
    .where(eq(paymentReversals.paymentId, paymentId));

  return {
    ...row,
    creditCentavos: row.status === "posted" ? row.amountCentavos - row.allocatedCentavos : 0,
    allocations,
    reversal: reversal ?? null,
  };
}

export async function getPayment(db: Db, paymentId: string): Promise<PaymentDetail> {
  return fetchPayment(db, paymentId);
}

export interface PaymentListItem {
  id: string;
  receiptNumber: string;
  status: string;
  paymentDate: string;
  postedAt: Date;
  method: string;
  amountCentavos: number;
  allocatedCentavos: number;
  referenceNumber: string | null;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  receivedByName: string;
}

export interface PaymentPage {
  items: PaymentListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Payment History: newest first. Search matches receipt, reference, account number or name. */
export async function listPayments(db: Db, query: PaymentListQuery): Promise<PaymentPage> {
  const filters: SQL[] = [];
  if (query.subscriberId) filters.push(eq(payments.subscriberId, query.subscriberId));
  if (query.method) filters.push(eq(payments.method, query.method));
  if (query.status) filters.push(eq(payments.status, query.status));
  if (query.from) filters.push(gte(payments.paymentDate, query.from));
  if (query.to) filters.push(lte(payments.paymentDate, query.to));
  if (query.search) {
    const pattern = likePattern(query.search);
    filters.push(
      or(
        ilike(payments.receiptNumber, pattern),
        ilike(payments.referenceNumber, pattern),
        ilike(subscribers.accountNumber, pattern),
        ilike(subscribers.fullName, pattern),
      )!,
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await db
    .select({ value: count() })
    .from(payments)
    .innerJoin(subscribers, eq(subscribers.id, payments.subscriberId))
    .where(where);
  const items = await db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      status: payments.status,
      paymentDate: payments.paymentDate,
      postedAt: payments.postedAt,
      method: payments.method,
      amountCentavos: payments.amountCentavos,
      allocatedCentavos: payments.allocatedCentavos,
      referenceNumber: payments.referenceNumber,
      subscriberId: payments.subscriberId,
      accountNumber: subscribers.accountNumber,
      subscriberName: subscribers.fullName,
      receivedByName: users.fullName,
    })
    .from(payments)
    .innerJoin(subscribers, eq(subscribers.id, payments.subscriberId))
    .innerJoin(users, eq(users.id, payments.receivedByUserId))
    .where(where)
    .orderBy(desc(payments.postedAt), desc(payments.receiptNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { items, total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

export interface PaymentContext {
  subscriber: { id: string; accountNumber: string; fullName: string; status: string };
  /** Ledger balance: positive is owed, negative is credit in the subscriber's favour. */
  balanceCentavos: number;
  creditCentavos: number;
  /** Oldest first: the order oldest-first allocation pays them in. */
  openInvoices: Array<{
    id: string;
    invoiceNumber: string;
    serviceNumber: string;
    periodStart: string;
    dueDate: string;
    totalCentavos: number;
    paidCentavos: number;
    adjustedCentavos: number;
    balanceCentavos: number;
    displayStatus: string;
  }>;
}

/**
 * What Receive Payment needs before posting: the balance, any credit and the open invoices.
 * The screen runs the shared allocateOldestFirst on these for its preview, the same
 * function posting uses, so the preview matches what will be posted.
 */
export async function getPaymentContext(db: Db, subscriberId: string): Promise<PaymentContext> {
  const [subscriber] = await db
    .select({
      id: subscribers.id,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      status: subscribers.status,
    })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId));
  if (!subscriber) throw new PaymentError("SUBSCRIBER_NOT_FOUND", 404, "Subscriber not found.");

  const today = await dbToday(db);
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: sql<string>`${invoices.invoiceNumber}`,
      serviceNumber: serviceAccounts.serviceNumber,
      periodStart: invoices.periodStart,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalCentavos: invoices.totalCentavos,
      paidCentavos: invoices.paidCentavos,
      adjustedCentavos: invoices.adjustedCentavos,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, invoices.serviceAccountId))
    .where(and(eq(invoices.subscriberId, subscriberId), inArray(invoices.status, ["unpaid", "partially_paid"])))
    .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));

  return {
    subscriber,
    balanceCentavos: await getSubscriberBalance(db, subscriberId),
    creditCentavos: await getSubscriberCredit(db, subscriberId),
    openInvoices: rows.map(({ status, ...r }) => ({
      ...r,
      balanceCentavos: balanceOf(r),
      displayStatus: invoiceDisplayStatus({ ...r, status }, today),
    })),
  };
}
