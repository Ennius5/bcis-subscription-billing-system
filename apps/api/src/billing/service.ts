import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  addMonths,
  dueDateFor,
  invoiceDateFor,
  invoiceDisplayStatus,
  periodBounds,
  periodLabel,
  periodOf,
  type BillingRunInput,
  type InvoiceListQuery,
  type InvoiceVoidInput,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { takeDocumentNumbers } from "../db/document-numbers";
import { dbToday, likePattern, type Tx } from "../db/query_helpers";
import { applyAvailableCredit } from "../payments/service";
import {
  billingCycles,
  invoiceItems,
  invoices,
  ledgerEntries,
  payments,
  serviceAccounts,
  servicePlans,
  subscribers,
} from "../db/schema";

export class BillingError extends Error {
  constructor(
    public readonly code:
      | "PERIOD_TOO_FAR"
      | "PERIOD_NOT_GENERATED"
      | "NOTHING_TO_FINALIZE"
      | "INVOICE_NOT_FOUND"
      | "INVOICE_IS_DRAFT"
      | "INVOICE_ALREADY_VOID"
      | "INVOICE_HAS_PAYMENTS",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Billing may be generated for any past month and up to one month ahead (advance billing). */
const MAX_MONTHS_AHEAD = 1;

/* ------------------------------- Summary ------------------------------- */

export interface BillingTotals {
  count: number;
  totalCentavos: number;
}

export interface BillingSummary {
  period: string;
  generated: boolean;
  drafts: BillingTotals;
  /** Finalized and not void: unpaid, partially paid, paid or credited. */
  finalized: BillingTotals;
  voided: BillingTotals;
  /** Active, billable accounts that have no invoice for this month yet. */
  notYetBilled: number;
}

/** Billable this month: active, billing started on or before the month's last day, no live invoice yet. */
function billableAccountsCondition(start: string, end: string): SQL {
  return sql`sa.status = 'active' AND sa.billing_start_date <= ${end}
    AND NOT EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.service_account_id = sa.id AND i.period_start = ${start} AND i.status <> 'void'
    )`;
}

export async function getBillingSummary(executor: DbOrTx, period: string): Promise<BillingSummary> {
  const { start, end } = periodBounds(period);
  const [cycle] = await executor
    .select({ id: billingCycles.id })
    .from(billingCycles)
    .where(eq(billingCycles.periodStart, start));

  const totals = await executor.execute<{ bucket: string; n: number; total: string }>(sql`
    SELECT CASE WHEN status = 'draft' THEN 'drafts' WHEN status = 'void' THEN 'voided' ELSE 'finalized' END AS bucket,
           count(*)::int AS n, coalesce(sum(total_centavos), 0)::bigint AS total
    FROM invoices WHERE period_start = ${start}
    GROUP BY 1
  `);
  const pick = (bucket: string): BillingTotals => {
    const row = totals.rows.find((r) => r.bucket === bucket);
    return { count: row?.n ?? 0, totalCentavos: Number(row?.total ?? 0) };
  };

  const pending = await executor.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM service_accounts sa WHERE ${billableAccountsCondition(start, end)}
  `);

  return {
    period,
    generated: cycle !== undefined,
    drafts: pick("drafts"),
    finalized: pick("finalized"),
    voided: pick("voided"),
    notYetBilled: pending.rows[0]?.n ?? 0,
  };
}

/** Locks the month's cycle row so generate, discard and finalize for one month run one at a time. */
async function lockCycle(tx: Tx, start: string) {
  const [cycle] = await tx.select().from(billingCycles).where(eq(billingCycles.periodStart, start)).for("update");
  return cycle;
}

/* ------------------------------ Generate ------------------------------ */

interface BillableAccount extends Record<string, unknown> {
  id: string;
  subscriber_id: string;
  service_number: string;
  billing_day: number;
  billing_start_date: string;
  current_rate_centavos: number;
  plan_id: string;
  plan_name: string;
  installation_fee_centavos: number;
  fee_already_billed: boolean;
}

/**
 * Creates draft invoices for every billable account that has none for the month yet.
 * Drafts have no number and are not on the ledger; running this twice only adds drafts
 * for accounts that became billable in between (AT-11).
 */
export async function generateBillingDrafts(
  db: Db,
  actorUserId: string,
  input: BillingRunInput,
): Promise<BillingSummary> {
  return db.transaction(async (tx) => {
    const today = await dbToday(tx);
    const latest = addMonths(periodOf(today), MAX_MONTHS_AHEAD);
    if (input.period > latest) {
      throw new BillingError(
        "PERIOD_TOO_FAR",
        422,
        `Billing can be generated up to ${periodLabel(latest)} (one month ahead).`,
      );
    }

    const { start, end } = periodBounds(input.period);
    await tx
      .insert(billingCycles)
      .values({ periodStart: start, periodEnd: end, createdByUserId: actorUserId })
      .onConflictDoNothing();
    const cycle = await lockCycle(tx, start);
    if (!cycle) throw new Error("Billing cycle missing after insert");

    // The accounts are locked too, so a rate change cannot slip in between reading and billing.
    const accounts = await tx.execute<BillableAccount>(sql`
      SELECT sa.id, sa.subscriber_id, sa.service_number, sa.billing_day,
             sa.billing_start_date::text AS billing_start_date, sa.current_rate_centavos,
             sa.plan_id, p.name AS plan_name, p.installation_fee_centavos,
             EXISTS (
               SELECT 1 FROM invoice_items it JOIN invoices i2 ON i2.id = it.invoice_id
               WHERE i2.service_account_id = sa.id AND i2.status <> 'void' AND it.item_type = 'installation_fee'
             ) AS fee_already_billed
      FROM service_accounts sa
      JOIN service_plans p ON p.id = sa.plan_id
      WHERE ${billableAccountsCondition(start, end)}
      ORDER BY sa.service_number
      FOR UPDATE OF sa
    `);

    let created = 0;
    let createdTotal = 0;
    for (const account of accounts.rows) {
      const lines: Array<Omit<typeof invoiceItems.$inferInsert, "invoiceId" | "lineNo">> = [];
      lines.push({
        itemType: "subscription",
        description: `${periodLabel(input.period)} – ${account.plan_name}`,
        amountCentavos: account.current_rate_centavos,
        planId: account.plan_id,
        rateCentavos: account.current_rate_centavos,
      });
      // The installation fee goes on the bill for the month billing started, once. If that bill
      // is voided, the fee is no longer billed anywhere, so re-billing the month charges it again.
      const startMonth = periodOf(account.billing_start_date) === input.period;
      if (startMonth && !account.fee_already_billed && account.installation_fee_centavos > 0) {
        lines.push({
          itemType: "installation_fee",
          description: "Installation fee",
          amountCentavos: account.installation_fee_centavos,
          planId: account.plan_id,
        });
      }
      const total = lines.reduce((sum, l) => sum + l.amountCentavos, 0);

      const [invoice] = await tx
        .insert(invoices)
        .values({
          billingCycleId: cycle.id,
          subscriberId: account.subscriber_id,
          serviceAccountId: account.id,
          periodStart: start,
          periodEnd: end,
          invoiceDate: invoiceDateFor(input.period),
          dueDate: dueDateFor(input.period, account.billing_day),
          totalCentavos: total,
          createdByUserId: actorUserId,
        })
        .returning({ id: invoices.id });
      if (!invoice) throw new Error("Failed to create draft invoice");
      await tx.insert(invoiceItems).values(lines.map((l, k) => ({ ...l, invoiceId: invoice.id, lineNo: k + 1 })));

      created++;
      createdTotal += total;
    }

    // Nothing new means nothing to audit.
    if (created > 0) {
      await writeAudit(tx, {
        actorUserId,
        action: "billing.generate",
        entityType: "billing_cycle",
        entityId: cycle.id,
        newValues: { period: input.period, draftsCreated: created, totalCentavos: createdTotal },
      });
    }

    return getBillingSummary(tx, input.period);
  });
}

/* ------------------------------ Discard ------------------------------ */

/** Deletes the month's drafts, e.g. to regenerate them after fixing a rate. Finalized invoices are untouched. */
export async function discardBillingDrafts(
  db: Db,
  actorUserId: string,
  input: BillingRunInput,
): Promise<BillingSummary> {
  return db.transaction(async (tx) => {
    const cycle = await lockCycle(tx, periodBounds(input.period).start);
    if (!cycle) {
      throw new BillingError("PERIOD_NOT_GENERATED", 404, `Billing for ${periodLabel(input.period)} has not been generated.`);
    }

    const removed = await tx
      .delete(invoices)
      .where(and(eq(invoices.billingCycleId, cycle.id), eq(invoices.status, "draft")))
      .returning({ total: invoices.totalCentavos });

    if (removed.length > 0) {
      await writeAudit(tx, {
        actorUserId,
        action: "billing.discard_drafts",
        entityType: "billing_cycle",
        entityId: cycle.id,
        oldValues: {
          period: input.period,
          drafts: removed.length,
          totalCentavos: removed.reduce((sum, r) => sum + r.total, 0),
        },
      });
    }

    return getBillingSummary(tx, input.period);
  });
}

/* ------------------------------ Finalize ------------------------------ */

export interface FinalizeResult extends BillingSummary {
  finalizedNow: number;
  firstNumber: string | null;
  lastNumber: string | null;
  /** Drafts left as drafts because their account is no longer active. */
  skipped: Array<{ invoiceId: string; serviceNumber: string; accountStatus: string }>;
  /** Advance credit (earlier payments) applied to the newly finalized invoices. */
  creditAppliedCentavos: number;
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  subscriber_id: string;
  service_account_id: string;
  invoice_date: string;
  total_centavos: number;
  account_status: string;
  service_number: string;
  description: string;
}

/**
 * Numbers the month's drafts, posts each one to the subscriber ledger as a debit and makes
 * it UNPAID. All in one transaction: either the whole month is finalized or nothing is.
 * Drafts whose account was suspended or terminated since generating are skipped and stay drafts.
 */
export async function finalizeBilling(db: Db, actorUserId: string, input: BillingRunInput): Promise<FinalizeResult> {
  return db.transaction(async (tx) => {
    const cycle = await lockCycle(tx, periodBounds(input.period).start);
    if (!cycle) {
      throw new BillingError("PERIOD_NOT_GENERATED", 404, `Billing for ${periodLabel(input.period)} has not been generated.`);
    }

    // Ordered by account so numbers run in a predictable order on the printed list.
    const drafts = await tx.execute<DraftRow>(sql`
      SELECT i.id, i.subscriber_id, i.service_account_id, i.invoice_date::text AS invoice_date,
             i.total_centavos, sa.status AS account_status, sa.service_number,
             (SELECT it.description FROM invoice_items it WHERE it.invoice_id = i.id AND it.line_no = 1) AS description
      FROM invoices i
      JOIN service_accounts sa ON sa.id = i.service_account_id
      JOIN subscribers s ON s.id = i.subscriber_id
      WHERE i.billing_cycle_id = ${cycle.id} AND i.status = 'draft'
      ORDER BY s.account_number, sa.service_number
      FOR UPDATE OF i
    `);
    const ready = drafts.rows.filter((d) => d.account_status === "active");
    const skipped = drafts.rows
      .filter((d) => d.account_status !== "active")
      .map((d) => ({ invoiceId: d.id, serviceNumber: d.service_number, accountStatus: d.account_status }));

    if (ready.length === 0) {
      throw new BillingError(
        "NOTHING_TO_FINALIZE",
        409,
        skipped.length > 0
          ? `No drafts can be finalized for ${periodLabel(input.period)}: their accounts are no longer active. Discard them.`
          : `There are no drafts to finalize for ${periodLabel(input.period)}. Generate billing first.`,
      );
    }

    const numbers = await takeDocumentNumbers(tx, "invoice", ready.length);
    const ledgerRows: Array<typeof ledgerEntries.$inferInsert> = [];
    let total = 0;

    for (const [k, draft] of ready.entries()) {
      const invoiceNumber = numbers[k]!;
      // A zero-rate account still gets a numbered invoice, but there is nothing to collect.
      const status = draft.total_centavos === 0 ? "paid" : "unpaid";
      await tx
        .update(invoices)
        .set({ status, invoiceNumber, finalizedAt: sql`now()`, finalizedByUserId: actorUserId })
        .where(eq(invoices.id, draft.id));

      if (draft.total_centavos > 0) {
        ledgerRows.push({
          subscriberId: draft.subscriber_id,
          serviceAccountId: draft.service_account_id,
          entryDate: draft.invoice_date,
          entryType: "invoice",
          reference: invoiceNumber,
          description: `${draft.description} (${draft.service_number})`,
          debitCentavos: draft.total_centavos,
          invoiceId: draft.id,
          createdByUserId: actorUserId,
        });
      }
      await writeAudit(tx, {
        actorUserId,
        action: "invoice.finalize",
        entityType: "invoice",
        entityId: draft.id,
        oldValues: { status: "draft" },
        newValues: { status, invoiceNumber, totalCentavos: draft.total_centavos },
      });
      total += draft.total_centavos;
    }
    if (ledgerRows.length > 0) await tx.insert(ledgerEntries).values(ledgerRows);

    // Subscribers who paid in advance: their credit pays the new invoices now (AT-03).
    // Sorted so concurrent operations always lock subscribers in the same order.
    const billed = [...new Set(ready.map((d) => d.subscriber_id))];
    const withCredit = await tx
      .selectDistinct({ subscriberId: payments.subscriberId })
      .from(payments)
      .where(
        and(
          inArray(payments.subscriberId, billed),
          eq(payments.status, "posted"),
          lt(payments.allocatedCentavos, payments.amountCentavos),
        ),
      )
      .orderBy(asc(payments.subscriberId));
    let creditApplied = 0;
    for (const { subscriberId } of withCredit) {
      creditApplied += await applyAvailableCredit(tx, actorUserId, subscriberId);
    }

    await writeAudit(tx, {
      actorUserId,
      action: "billing.finalize",
      entityType: "billing_cycle",
      entityId: cycle.id,
      newValues: {
        period: input.period,
        finalized: ready.length,
        firstNumber: numbers[0],
        lastNumber: numbers[numbers.length - 1],
        totalCentavos: total,
        skipped: skipped.length,
        creditAppliedCentavos: creditApplied,
      },
    });

    return {
      ...(await getBillingSummary(tx, input.period)),
      finalizedNow: ready.length,
      firstNumber: numbers[0] ?? null,
      lastNumber: numbers[numbers.length - 1] ?? null,
      skipped,
      creditAppliedCentavos: creditApplied,
    };
  });
}

/* -------------------------------- Void -------------------------------- */

/**
 * Voids a finalized invoice. The invoice and its number stay; the ledger gets a credit that
 * cancels the original debit, and the month becomes free to bill again.
 */
export async function voidInvoice(
  db: Db,
  actorUserId: string,
  invoiceId: string,
  input: InvoiceVoidInput,
): Promise<InvoiceDetail> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!invoice) throw new BillingError("INVOICE_NOT_FOUND", 404, "Invoice not found.");
    if (invoice.status === "draft") {
      throw new BillingError("INVOICE_IS_DRAFT", 409, "Drafts are not voided; discard the month's drafts instead.");
    }
    if (invoice.status === "void") {
      throw new BillingError("INVOICE_ALREADY_VOID", 409, `Invoice ${invoice.invoiceNumber} is already void.`);
    }
    if (invoice.paidCentavos > 0) {
      throw new BillingError(
        "INVOICE_HAS_PAYMENTS",
        409,
        `Invoice ${invoice.invoiceNumber} has payments applied. Reverse those payments before voiding it.`,
      );
    }

    await tx
      .update(invoices)
      .set({ status: "void", voidedAt: sql`now()`, voidedByUserId: actorUserId, voidReason: input.reason })
      .where(eq(invoices.id, invoiceId));

    if (invoice.totalCentavos > 0) {
      await tx.insert(ledgerEntries).values({
        subscriberId: invoice.subscriberId,
        serviceAccountId: invoice.serviceAccountId,
        entryDate: await dbToday(tx),
        entryType: "invoice_void",
        reference: invoice.invoiceNumber!,
        description: `Void of ${invoice.invoiceNumber}: ${input.reason}`,
        creditCentavos: invoice.totalCentavos,
        invoiceId,
        createdByUserId: actorUserId,
      });
    }

    await writeAudit(tx, {
      actorUserId,
      action: "invoice.void",
      entityType: "invoice",
      entityId: invoiceId,
      reason: input.reason,
      oldValues: { status: invoice.status },
      newValues: { status: "void", invoiceNumber: invoice.invoiceNumber, totalCentavos: invoice.totalCentavos },
    });

    return fetchInvoice(tx, invoiceId);
  });
}

/* ------------------------------- Reading ------------------------------- */

const invoiceColumns = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  status: invoices.status,
  periodStart: invoices.periodStart,
  periodEnd: invoices.periodEnd,
  invoiceDate: invoices.invoiceDate,
  dueDate: invoices.dueDate,
  totalCentavos: invoices.totalCentavos,
  paidCentavos: invoices.paidCentavos,
  subscriberId: invoices.subscriberId,
  accountNumber: subscribers.accountNumber,
  subscriberName: subscribers.fullName,
  serviceAccountId: invoices.serviceAccountId,
  serviceNumber: serviceAccounts.serviceNumber,
};

/** The row shape `invoiceColumns` selects. */
interface InvoiceBase {
  id: string;
  invoiceNumber: string | null;
  status: string;
  periodStart: string;
  periodEnd: string;
  invoiceDate: string;
  dueDate: string;
  totalCentavos: number;
  paidCentavos: number;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  serviceAccountId: string;
  serviceNumber: string;
}

export interface InvoiceListItem extends InvoiceBase {
  /** The stored status, or "overdue" for an open invoice past its due date. */
  displayStatus: string;
  balanceCentavos: number;
}

export interface InvoiceDetail extends InvoiceListItem {
  planName: string;
  items: Array<{
    lineNo: number;
    itemType: string;
    description: string;
    amountCentavos: number;
    rateCentavos: number | null;
  }>;
  finalizedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

function withDisplay<T extends InvoiceBase>(row: T, today: string): T & Pick<InvoiceListItem, "displayStatus" | "balanceCentavos"> {
  return {
    ...row,
    displayStatus: invoiceDisplayStatus(row, today),
    balanceCentavos: row.status === "void" ? 0 : row.totalCentavos - row.paidCentavos,
  };
}

async function fetchInvoice(executor: DbOrTx, invoiceId: string): Promise<InvoiceDetail> {
  const [row] = await executor
    .select({
      ...invoiceColumns,
      planName: servicePlans.name,
      finalizedAt: invoices.finalizedAt,
      voidedAt: invoices.voidedAt,
      voidReason: invoices.voidReason,
    })
    .from(invoices)
    .innerJoin(subscribers, eq(subscribers.id, invoices.subscriberId))
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, invoices.serviceAccountId))
    .innerJoin(servicePlans, eq(servicePlans.id, serviceAccounts.planId))
    .where(eq(invoices.id, invoiceId));
  if (!row) throw new BillingError("INVOICE_NOT_FOUND", 404, "Invoice not found.");

  const items = await executor
    .select({
      lineNo: invoiceItems.lineNo,
      itemType: invoiceItems.itemType,
      description: invoiceItems.description,
      amountCentavos: invoiceItems.amountCentavos,
      rateCentavos: invoiceItems.rateCentavos,
    })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.lineNo));

  return { ...withDisplay(row, await dbToday(executor)), items };
}

export async function getInvoice(db: Db, invoiceId: string): Promise<InvoiceDetail> {
  return fetchInvoice(db, invoiceId);
}

export interface InvoicePage {
  items: InvoiceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listInvoices(db: Db, query: InvoiceListQuery): Promise<InvoicePage> {
  const today = await dbToday(db);
  const filters: SQL[] = [];
  if (query.period) filters.push(eq(invoices.periodStart, periodBounds(query.period).start));
  if (query.subscriberId) filters.push(eq(invoices.subscriberId, query.subscriberId));
  if (query.serviceAccountId) filters.push(eq(invoices.serviceAccountId, query.serviceAccountId));
  if (query.status === "overdue") {
    filters.push(
      inArray(invoices.status, ["unpaid", "partially_paid"]),
      lt(invoices.dueDate, today),
      lt(invoices.paidCentavos, invoices.totalCentavos),
    );
  } else if (query.status) {
    filters.push(eq(invoices.status, query.status));
  }
  if (query.search) {
    const pattern = likePattern(query.search);
    filters.push(
      or(
        ilike(invoices.invoiceNumber, pattern),
        ilike(subscribers.accountNumber, pattern),
        ilike(subscribers.fullName, pattern),
        ilike(serviceAccounts.serviceNumber, pattern),
      )!,
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await db
    .select({ value: count() })
    .from(invoices)
    .innerJoin(subscribers, eq(subscribers.id, invoices.subscriberId))
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, invoices.serviceAccountId))
    .where(where);

  const rows = await db
    .select(invoiceColumns)
    .from(invoices)
    .innerJoin(subscribers, eq(subscribers.id, invoices.subscriberId))
    .innerJoin(serviceAccounts, eq(serviceAccounts.id, invoices.serviceAccountId))
    .where(where)
    .orderBy(desc(invoices.periodStart), asc(subscribers.accountNumber), asc(serviceAccounts.serviceNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((r) => withDisplay(r, today)),
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}
