import { sql, type SQL } from "drizzle-orm";
import {
  AGING_BUCKETS,
  RECEIVABLE_SETTING_DEFAULTS,
  RECEIVABLE_SETTING_KEYS,
  agingBucket,
  agingTotals,
  countPastGrace,
  daysPastDue,
  isPastGrace,
  isSuspensionCandidate,
  receivableSettingsSchema,
  type AgingBucket,
  type AgingQuery,
  type ReceivableListQuery,
  type ReceivableSettings,
  type ReceivableSettingsUpdateInput,
  type ServiceAccountStatus,
  type ServiceTypeCode,
  type SuspensionCandidateQuery,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { changedFields, dbToday, likePattern } from "../db/query_helpers";

/*
 * Receivables (spec 3.9) and suspension candidates (spec 3.10). Everything is as of today
 * (the database date). Open invoices are loaded once per request and grouped here with the
 * shared rules (agingBucket, isSuspensionCandidate), so the screens, tests and SQL can never
 * disagree on what "overdue" or "candidate" means.
 */

/* ------------------------------ Settings ------------------------------ */

/** The grace period and suspension threshold; a missing row falls back to the default. */
export async function getReceivableSettings(executor: DbOrTx): Promise<ReceivableSettings> {
  const result = await executor.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM application_settings
    WHERE key IN (${RECEIVABLE_SETTING_KEYS.gracePeriodDays}, ${RECEIVABLE_SETTING_KEYS.suspensionThresholdInvoices})
  `);
  const stored = new Map(result.rows.map((r) => [r.key, Number(r.value)]));
  return receivableSettingsSchema.parse({
    gracePeriodDays: stored.get(RECEIVABLE_SETTING_KEYS.gracePeriodDays) ?? RECEIVABLE_SETTING_DEFAULTS.gracePeriodDays,
    suspensionThresholdInvoices:
      stored.get(RECEIVABLE_SETTING_KEYS.suspensionThresholdInvoices) ??
      RECEIVABLE_SETTING_DEFAULTS.suspensionThresholdInvoices,
  });
}

/**
 * Changes the grace period and/or threshold (settings.manage). Only changed values are
 * written and audited; a no-op writes nothing. The rows are locked so two PCs saving at
 * once cannot lose an update.
 */
export async function updateReceivableSettings(
  db: Db,
  actorUserId: string,
  input: ReceivableSettingsUpdateInput,
): Promise<ReceivableSettings> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT key FROM application_settings
      WHERE key IN (${RECEIVABLE_SETTING_KEYS.gracePeriodDays}, ${RECEIVABLE_SETTING_KEYS.suspensionThresholdInvoices})
      FOR UPDATE
    `);
    const existing = await getReceivableSettings(tx);
    const { reason, ...fields } = input;
    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return existing;

    for (const [field, value] of Object.entries(newValues)) {
      const key = RECEIVABLE_SETTING_KEYS[field as keyof ReceivableSettings];
      await tx.execute(sql`
        INSERT INTO application_settings (key, value, updated_at) VALUES (${key}, ${String(value)}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `);
    }
    await writeAudit(tx, {
      actorUserId,
      action: "settings.update",
      entityType: "application_settings",
      reason: reason ?? null,
      oldValues,
      newValues,
    });
    return getReceivableSettings(tx);
  });
}

/* ---------------------------- Open invoices ---------------------------- */

// A type alias (not an interface) so it fits db.execute's Record<string, unknown> constraint.
type OpenInvoiceRow = {
  invoice_id: string;
  invoice_number: string;
  due_date: string;
  open_centavos: number;
  service_account_id: string;
  service_number: string;
  service_status: ServiceAccountStatus;
  subscriber_id: string;
  account_number: string;
  subscriber_name: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  service_type: ServiceTypeCode;
  area_id: string | null;
  area_name: string | null;
  collector_id: string | null;
  collector_code: string | null;
  collector_name: string | null;
  last_payment_date: string | null;
};

type Filters = AgingQuery & { search?: string };

/**
 * Filter conditions on the aliases sa (service account), s (subscriber), p (plan) and
 * st (service type). The collector is the effective one: the service's override, else the
 * subscriber's. The area is the subscriber's collection area.
 */
function filterConditions(f: Filters): SQL[] {
  const parts: SQL[] = [];
  if (f.collectorId) parts.push(sql`coalesce(sa.assigned_collector_id, s.assigned_collector_id) = ${f.collectorId}`);
  if (f.areaId) parts.push(sql`s.collection_area_id = ${f.areaId}`);
  if (f.planId) parts.push(sql`sa.plan_id = ${f.planId}`);
  if (f.serviceType) parts.push(sql`st.code = ${f.serviceType}`);
  if (f.search) {
    const pattern = likePattern(f.search);
    parts.push(sql`(s.account_number ILIKE ${pattern} OR s.full_name ILIKE ${pattern} OR sa.service_number ILIKE ${pattern})`);
  }
  return parts;
}

const andAll = (parts: SQL[]): SQL => (parts.length > 0 ? sql` AND ${sql.join(parts, sql` AND `)}` : sql``);

/**
 * Every finalized invoice with something left to pay (effective total less paid), oldest
 * due first. Terminated accounts with debt are included: the debt is still owed.
 */
async function loadOpenInvoices(db: DbOrTx, filters: Filters, activeOnly = false): Promise<OpenInvoiceRow[]> {
  const conditions = filterConditions(filters);
  if (activeOnly) conditions.push(sql`sa.status = 'active'`);
  const result = await db.execute<OpenInvoiceRow>(sql`
    SELECT i.id AS invoice_id, i.invoice_number, i.due_date::text AS due_date,
      (i.total_centavos + i.adjusted_centavos - i.paid_centavos) AS open_centavos,
      sa.id AS service_account_id, sa.service_number, sa.status AS service_status,
      s.id AS subscriber_id, s.account_number, s.full_name AS subscriber_name,
      p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, st.code AS service_type,
      a.id AS area_id, a.name AS area_name,
      c.id AS collector_id, c.code AS collector_code, c.full_name AS collector_name,
      lp.last_payment_date
    FROM invoices i
    JOIN service_accounts sa ON sa.id = i.service_account_id
    JOIN subscribers s ON s.id = i.subscriber_id
    JOIN service_plans p ON p.id = sa.plan_id
    JOIN service_types st ON st.id = p.service_type_id
    LEFT JOIN collection_areas a ON a.id = s.collection_area_id
    LEFT JOIN collectors c ON c.id = coalesce(sa.assigned_collector_id, s.assigned_collector_id)
    LEFT JOIN (
      SELECT subscriber_id, max(payment_date)::text AS last_payment_date
      FROM payments WHERE status = 'posted' GROUP BY subscriber_id
    ) lp ON lp.subscriber_id = s.id
    WHERE i.status IN ('unpaid', 'partially_paid')
      AND i.total_centavos + i.adjusted_centavos - i.paid_centavos > 0
      ${andAll(conditions)}
    ORDER BY i.due_date, i.invoice_number
  `);
  return result.rows;
}

/* ------------------------- Outstanding / Overdue ------------------------- */

/** One service account with an open balance (spec 3.9 overdue list columns). */
export interface ReceivableRow {
  serviceAccountId: string;
  serviceNumber: string;
  serviceStatus: ServiceAccountStatus;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  planId: string;
  planCode: string;
  planName: string;
  serviceType: ServiceTypeCode;
  areaId: string | null;
  areaName: string | null;
  collectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  openInvoiceCount: number;
  /** Past-due open invoices (one per month billed). */
  monthsUnpaid: number;
  oldestInvoiceId: string;
  oldestInvoiceNumber: string;
  oldestDueDate: string;
  /** Days the oldest open invoice is past due; 0 when it is not due yet. */
  daysPastDue: number;
  /** Delinquency age: the bucket of the oldest open invoice. */
  bucket: AgingBucket;
  /** The subscriber's last posted payment, any service and channel. */
  lastPaymentDate: string | null;
  currentCentavos: number;
  arrearsCentavos: number;
  totalOpenCentavos: number;
}

/** Groups open invoices (already oldest first) into one row per service account. */
function groupByServiceAccount(invoices: readonly OpenInvoiceRow[], today: string): Map<string, { row: ReceivableRow; invoices: OpenInvoiceRow[] }> {
  const groups = new Map<string, { row: ReceivableRow; invoices: OpenInvoiceRow[] }>();
  for (const inv of invoices) {
    let group = groups.get(inv.service_account_id);
    if (!group) {
      group = {
        invoices: [],
        row: {
          serviceAccountId: inv.service_account_id,
          serviceNumber: inv.service_number,
          serviceStatus: inv.service_status,
          subscriberId: inv.subscriber_id,
          accountNumber: inv.account_number,
          subscriberName: inv.subscriber_name,
          planId: inv.plan_id,
          planCode: inv.plan_code,
          planName: inv.plan_name,
          serviceType: inv.service_type,
          areaId: inv.area_id,
          areaName: inv.area_name,
          collectorId: inv.collector_id,
          collectorCode: inv.collector_code,
          collectorName: inv.collector_name,
          openInvoiceCount: 0,
          monthsUnpaid: 0,
          oldestInvoiceId: inv.invoice_id,
          oldestInvoiceNumber: inv.invoice_number,
          oldestDueDate: inv.due_date,
          daysPastDue: Math.max(0, daysPastDue(inv.due_date, today)),
          bucket: agingBucket(inv.due_date, today),
          lastPaymentDate: inv.last_payment_date,
          currentCentavos: 0,
          arrearsCentavos: 0,
          totalOpenCentavos: 0,
        },
      };
      groups.set(inv.service_account_id, group);
    }
    const { row } = group;
    group.invoices.push(inv);
    row.openInvoiceCount += 1;
    row.totalOpenCentavos += inv.open_centavos;
    if (daysPastDue(inv.due_date, today) > 0) {
      row.monthsUnpaid += 1;
      row.arrearsCentavos += inv.open_centavos;
    } else {
      row.currentCentavos += inv.open_centavos;
    }
  }
  return groups;
}

const byName = (a: ReceivableRow, b: ReceivableRow) =>
  a.subscriberName.localeCompare(b.subscriberName) || a.serviceNumber.localeCompare(b.serviceNumber);

const SORTS: Record<ReceivableListQuery["sort"], (a: ReceivableRow, b: ReceivableRow) => number> = {
  oldest: (a, b) => a.oldestDueDate.localeCompare(b.oldestDueDate) || byName(a, b),
  arrears: (a, b) => b.arrearsCentavos - a.arrearsCentavos || byName(a, b),
  balance: (a, b) => b.totalOpenCentavos - a.totalOpenCentavos || byName(a, b),
  name: byName,
};

export interface ReceivablePage {
  asOf: string;
  items: ReceivableRow[];
  /** Totals over every matching row, not just this page. */
  total: number;
  totalOpenCentavos: number;
  totalArrearsCentavos: number;
  page: number;
  pageSize: number;
}

/** Outstanding (every open balance) or Overdue (only accounts with arrears). */
export async function listReceivables(db: DbOrTx, query: ReceivableListQuery): Promise<ReceivablePage> {
  const today = await dbToday(db);
  const groups = groupByServiceAccount(await loadOpenInvoices(db, query), today);

  let rows = [...groups.values()].map((g) => g.row);
  if (query.view === "overdue") rows = rows.filter((r) => r.arrearsCentavos > 0);
  if (query.bucket) rows = rows.filter((r) => r.bucket === query.bucket);
  rows.sort(SORTS[query.sort]);

  const start = (query.page - 1) * query.pageSize;
  return {
    asOf: today,
    items: rows.slice(start, start + query.pageSize),
    total: rows.length,
    totalOpenCentavos: rows.reduce((t, r) => t + r.totalOpenCentavos, 0),
    totalArrearsCentavos: rows.reduce((t, r) => t + r.arrearsCentavos, 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}

/* -------------------------------- Aging -------------------------------- */

export interface AgingBucketLine {
  bucket: AgingBucket;
  /** Open balances of invoices whose own due date falls in this bucket. */
  amountCentavos: number;
  invoiceCount: number;
  /** Service accounts whose oldest open invoice is in this bucket (delinquency age). */
  accountCount: number;
}

export interface AgingReport {
  asOf: string;
  buckets: AgingBucketLine[];
  totalOpenCentavos: number;
  /** Everything past due (all buckets except current). */
  overdueCentavos: number;
  overdueAccountCount: number;
  overdueSubscriberCount: number;
  /**
   * Unallocated payment money of the subscribers in the selection (all subscribers when
   * nothing is filtered). Shown separately, not netted into the buckets.
   */
  unappliedCreditCentavos: number;
  /** Open balances less unapplied credit: what the ledgers add up to. */
  netReceivableCentavos: number;
}

/** AR aging (spec 3.9): Current, 1-30, 31-60, 61-90 and 90+ days past due, as of today. */
export async function getAgingReport(db: DbOrTx, query: AgingQuery): Promise<AgingReport> {
  const today = await dbToday(db);
  const invoices = await loadOpenInvoices(db, query);
  const amounts = agingTotals(
    invoices.map((i) => ({ dueDate: i.due_date, openCentavos: i.open_centavos })),
    today,
  );
  const rows = [...groupByServiceAccount(invoices, today).values()].map((g) => g.row);
  const overdueRows = rows.filter((r) => r.arrearsCentavos > 0);

  const buckets = AGING_BUCKETS.map((bucket) => ({
    bucket,
    amountCentavos: amounts[bucket],
    invoiceCount: invoices.filter((i) => agingBucket(i.due_date, today) === bucket).length,
    accountCount: rows.filter((r) => r.bucket === bucket).length,
  }));
  const totalOpenCentavos = buckets.reduce((t, b) => t + b.amountCentavos, 0);
  const unappliedCreditCentavos = await unappliedCredit(db, query);

  return {
    asOf: today,
    buckets,
    totalOpenCentavos,
    overdueCentavos: totalOpenCentavos - amounts.current,
    overdueAccountCount: overdueRows.length,
    overdueSubscriberCount: new Set(overdueRows.map((r) => r.subscriberId)).size,
    unappliedCreditCentavos,
    netReceivableCentavos: totalOpenCentavos - unappliedCreditCentavos,
  };
}

/** Credit held by subscribers that have at least one service account matching the filters. */
async function unappliedCredit(db: DbOrTx, filters: AgingQuery): Promise<number> {
  const conditions = filterConditions(filters);
  const inSelection =
    conditions.length === 0
      ? sql``
      : sql`AND EXISTS (
          SELECT 1 FROM service_accounts sa
          JOIN service_plans p ON p.id = sa.plan_id
          JOIN service_types st ON st.id = p.service_type_id
          WHERE sa.subscriber_id = s.id ${andAll(conditions)}
        )`;
  const result = await db.execute<{ credit: string }>(sql`
    SELECT coalesce(sum(pm.amount_centavos - pm.allocated_centavos), 0)::bigint AS credit
    FROM payments pm JOIN subscribers s ON s.id = pm.subscriber_id
    WHERE pm.status = 'posted' ${inSelection}
  `);
  return Number(result.rows[0]?.credit ?? 0);
}

/* ------------------------- Suspension candidates ------------------------- */

export interface SuspensionCandidate extends ReceivableRow {
  /** Open invoices more than the grace period past due. */
  pastGraceCount: number;
  pastGraceCentavos: number;
}

export interface SuspensionCandidateList {
  asOf: string;
  settings: ReceivableSettings;
  items: SuspensionCandidate[];
}

/**
 * Active service accounts with at least the threshold number of open invoices past the
 * grace period. Advice only: staff decide and suspend each one by hand. Most overdue first.
 */
export async function listSuspensionCandidates(
  db: DbOrTx,
  query: SuspensionCandidateQuery,
): Promise<SuspensionCandidateList> {
  const today = await dbToday(db);
  const settings = await getReceivableSettings(db);
  const groups = groupByServiceAccount(await loadOpenInvoices(db, query, true), today);

  const items: SuspensionCandidate[] = [];
  for (const { row, invoices } of groups.values()) {
    const ages = invoices.map((i) => ({ dueDate: i.due_date, openCentavos: i.open_centavos }));
    if (!isSuspensionCandidate(row.serviceStatus, ages, today, settings)) continue;
    items.push({
      ...row,
      pastGraceCount: countPastGrace(ages, today, settings.gracePeriodDays),
      pastGraceCentavos: ages
        .filter((a) => isPastGrace(a.dueDate, today, settings.gracePeriodDays))
        .reduce((t, a) => t + a.openCentavos, 0),
    });
  }
  items.sort((a, b) => b.pastGraceCount - a.pastGraceCount || SORTS.oldest(a, b));
  return { asOf: today, settings, items };
}

/* ---------------------------- Filter options ---------------------------- */

export interface ReceivableFilterOptions {
  collectors: Array<{ id: string; code: string; fullName: string; isActive: boolean }>;
  areas: Array<{ id: string; code: string; name: string; isActive: boolean }>;
  plans: Array<{ id: string; code: string; name: string; serviceType: ServiceTypeCode; isActive: boolean }>;
}

/**
 * Choices for the receivables filters. Inactive entries are included (debt can sit under
 * a collector or plan that is no longer used), active ones first. This exists so cashiers and
 * technicians can filter without the collection.view or plan.view permissions.
 */
export async function getReceivableFilterOptions(db: DbOrTx): Promise<ReceivableFilterOptions> {
  const collectors = await db.execute<{ id: string; code: string; full_name: string; is_active: boolean }>(sql`
    SELECT id, code, full_name, is_active FROM collectors ORDER BY is_active DESC, code
  `);
  const areas = await db.execute<{ id: string; code: string; name: string; is_active: boolean }>(sql`
    SELECT id, code, name, is_active FROM collection_areas ORDER BY is_active DESC, code
  `);
  const plans = await db.execute<{ id: string; code: string; name: string; service_type: ServiceTypeCode; is_active: boolean }>(sql`
    SELECT p.id, p.code, p.name, st.code AS service_type, p.is_active
    FROM service_plans p JOIN service_types st ON st.id = p.service_type_id
    ORDER BY p.is_active DESC, p.code
  `);
  return {
    collectors: collectors.rows.map((c) => ({ id: c.id, code: c.code, fullName: c.full_name, isActive: c.is_active })),
    areas: areas.rows.map((a) => ({ id: a.id, code: a.code, name: a.name, isActive: a.is_active })),
    plans: plans.rows.map((p) => ({ id: p.id, code: p.code, name: p.name, serviceType: p.service_type, isActive: p.is_active })),
  };
}
