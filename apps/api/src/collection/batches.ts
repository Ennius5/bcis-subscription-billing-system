import { and, asc, count, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  batchTransitionProblem,
  dueSnapshot,
  type BatchAccountAddInput,
  type BatchCancelInput,
  type BatchCreateInput,
  type BatchListQuery,
  type CollectionBatchStatus,
  type DueSnapshot,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { takeDocumentNumbers } from "../db/document-numbers";
import { dbToday, type Tx } from "../db/query_helpers";
import {
  batchAccounts,
  collectionAreas,
  collectionBatches,
  collectors,
  invoices,
  payments,
  serviceAccounts,
  subscriberAddresses,
  subscribers,
  users,
} from "../db/schema";

export class BatchError extends Error {
  constructor(
    public readonly code:
      | "BATCH_NOT_FOUND"
      | "COLLECTOR_NOT_FOUND"
      | "COLLECTOR_INACTIVE"
      | "AREA_NOT_FOUND"
      | "AREA_INACTIVE"
      | "SUBSCRIBER_NOT_FOUND"
      | "SUBSCRIBER_ARCHIVED"
      | "ALREADY_ON_BATCH"
      | "ON_ANOTHER_BATCH"
      | "NOT_ON_BATCH"
      | "BATCH_NOT_EDITABLE"
      | "BATCH_EMPTY"
      | "INVALID_TRANSITION"
      | "HAS_COLLECTIONS",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Batches whose subscribers are spoken for: a subscriber is on at most one of these. */
const LIVE_STATUSES: CollectionBatchStatus[] = ["open", "in_progress"];

/* ------------------------------ Locking ------------------------------ */

/**
 * Serializes every change to which subscribers are on live batches (building a batch,
 * adding an account), so two PCs cannot put the same subscriber on two batches at once.
 * Held until the transaction ends. Reads are not blocked.
 */
async function lockLiveBatchMembership(tx: Tx) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bcis.batch_accounts'))`);
}

type BatchRow = typeof collectionBatches.$inferSelect;

async function lockBatch(tx: Tx, batchId: string): Promise<BatchRow> {
  const [row] = await tx.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).for("update");
  if (!row) throw new BatchError("BATCH_NOT_FOUND", 404, "Collection batch not found.");
  return row;
}

function ensureTransition(batch: BatchRow, to: CollectionBatchStatus) {
  const problem = batchTransitionProblem(batch.status as CollectionBatchStatus, to);
  if (problem) throw new BatchError("INVALID_TRANSITION", 409, problem);
}

/* ------------------------------ Snapshot ------------------------------ */

/**
 * Current bill, arrears, credit and total due for each subscriber, as of `today`, using the
 * same open-invoice and credit rules as Receive Payment. Subscribers owing nothing get zeros.
 */
async function snapshotsFor(tx: DbOrTx, subscriberIds: string[], today: string): Promise<Map<string, DueSnapshot>> {
  const result = new Map<string, DueSnapshot>();
  if (subscriberIds.length === 0) return result;

  const open = await tx
    .select({
      subscriberId: invoices.subscriberId,
      dueDate: invoices.dueDate,
      openCentavos: sql<number>`(${invoices.totalCentavos} + ${invoices.adjustedCentavos} - ${invoices.paidCentavos})::int`,
    })
    .from(invoices)
    .where(and(inArray(invoices.subscriberId, subscriberIds), inArray(invoices.status, ["unpaid", "partially_paid"])));
  const credits = await tx
    .select({
      subscriberId: payments.subscriberId,
      creditCentavos: sql<number>`sum(${payments.amountCentavos} - ${payments.allocatedCentavos})::int`,
    })
    .from(payments)
    .where(and(inArray(payments.subscriberId, subscriberIds), eq(payments.status, "posted")))
    .groupBy(payments.subscriberId);

  const creditBySubscriber = new Map(credits.map((c) => [c.subscriberId, c.creditCentavos]));
  for (const id of subscriberIds) {
    const mine = open.filter((i) => i.subscriberId === id);
    result.set(id, dueSnapshot(mine, creditBySubscriber.get(id) ?? 0, today));
  }
  return result;
}

/** For each subscriber already on a live batch: that batch's number. */
async function liveBatchOf(tx: DbOrTx, subscriberIds: string[]): Promise<Map<string, string>> {
  if (subscriberIds.length === 0) return new Map();
  const rows = await tx
    .select({ subscriberId: batchAccounts.subscriberId, batchNumber: collectionBatches.batchNumber })
    .from(batchAccounts)
    .innerJoin(collectionBatches, eq(collectionBatches.id, batchAccounts.batchId))
    .where(and(inArray(batchAccounts.subscriberId, subscriberIds), inArray(collectionBatches.status, LIVE_STATUSES)));
  return new Map(rows.map((r) => [r.subscriberId, r.batchNumber]));
}

/* ------------------------------- Create ------------------------------- */

export interface SkippedSubscriber {
  subscriberId: string;
  accountNumber: string;
  fullName: string;
  /** The live batch the subscriber is already on. */
  batchNumber: string;
}

export interface CreateBatchResult {
  batch: BatchDetail;
  /** Subscribers who owe and belong to the collector but are already on another live batch. */
  skipped: SkippedSubscriber[];
}

/**
 * Builds a batch for one collector and date. Its accounts are the collector's subscribers
 * (by each service's effective collector: the service's own override, else the subscriber's
 * collector), limited to one area if given, who owe something today. Each gets a snapshot
 * of what they owe. Subscribers already on another open or in-progress batch are left out
 * and reported back.
 */
export async function createBatch(db: Db, actorUserId: string, input: BatchCreateInput): Promise<CreateBatchResult> {
  const { batchId, skipped } = await db.transaction(async (tx) => {
    const [collector] = await tx.select().from(collectors).where(eq(collectors.id, input.collectorId));
    if (!collector) throw new BatchError("COLLECTOR_NOT_FOUND", 404, "Collector not found.");
    if (!collector.isActive) throw new BatchError("COLLECTOR_INACTIVE", 409, `Collector ${collector.code} is inactive.`);

    let areaCode: string | null = null;
    if (input.collectionAreaId) {
      const [area] = await tx.select().from(collectionAreas).where(eq(collectionAreas.id, input.collectionAreaId));
      if (!area) throw new BatchError("AREA_NOT_FOUND", 404, "Collection area not found.");
      if (!area.isActive) throw new BatchError("AREA_INACTIVE", 409, `Area ${area.code} is inactive.`);
      areaCode = area.code;
    }

    await lockLiveBatchMembership(tx);
    const today = await dbToday(tx);

    const filters: SQL[] = [
      sql`coalesce(${serviceAccounts.assignedCollectorId}, ${subscribers.assignedCollectorId}) = ${input.collectorId}`,
      ne(subscribers.status, "archived"),
    ];
    if (input.collectionAreaId) filters.push(eq(subscribers.collectionAreaId, input.collectionAreaId));
    const candidates = await tx
      .selectDistinct({ id: subscribers.id, accountNumber: subscribers.accountNumber, fullName: subscribers.fullName })
      .from(subscribers)
      .innerJoin(serviceAccounts, eq(serviceAccounts.subscriberId, subscribers.id))
      .where(and(...filters));

    const ids = candidates.map((c) => c.id);
    const snapshots = await snapshotsFor(tx, ids, today);
    const onOtherBatch = await liveBatchOf(tx, ids);
    const owing = candidates.filter((c) => snapshots.get(c.id)!.totalDueCentavos > 0);

    const [batchNumber] = await takeDocumentNumbers(tx, "collection_batch", 1);
    const [batch] = await tx
      .insert(collectionBatches)
      .values({
        batchNumber: batchNumber!,
        collectorId: input.collectorId,
        collectionAreaId: input.collectionAreaId ?? null,
        collectionDate: input.collectionDate,
        notes: input.notes ?? null,
        createdByUserId: actorUserId,
      })
      .returning({ id: collectionBatches.id });

    const included = owing.filter((c) => !onOtherBatch.has(c.id));
    if (included.length > 0) {
      await tx
        .insert(batchAccounts)
        .values(included.map((c) => ({ batchId: batch!.id, subscriberId: c.id, addedByUserId: actorUserId, ...snapshots.get(c.id)! })));
    }

    const leftOut = owing
      .filter((c) => onOtherBatch.has(c.id))
      .map((c) => ({ subscriberId: c.id, accountNumber: c.accountNumber, fullName: c.fullName, batchNumber: onOtherBatch.get(c.id)! }));

    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.create",
      entityType: "collection_batch",
      entityId: batch!.id,
      newValues: {
        batchNumber,
        collectorCode: collector.code,
        areaCode,
        collectionDate: input.collectionDate,
        accountCount: included.length,
        totalDueCentavos: included.reduce((sum, c) => sum + snapshots.get(c.id)!.totalDueCentavos, 0),
        skippedAccountNumbers: leftOut.map((s) => s.accountNumber),
      },
    });
    return { batchId: batch!.id, skipped: leftOut };
  });
  return { batch: await getBatch(db, batchId), skipped };
}

/* ------------------------------ Accounts ------------------------------ */

/**
 * Adds one subscriber by hand while the batch is open or in progress (a late request, a
 * neighbour who asks the collector to drop by). Any subscriber who is not archived may be
 * added, even one owing nothing today; the snapshot is taken now.
 */
export async function addBatchAccount(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: BatchAccountAddInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!LIVE_STATUSES.includes(batch.status as CollectionBatchStatus)) {
      throw new BatchError("BATCH_NOT_EDITABLE", 409, "Accounts can only be added while the batch is open or in progress.");
    }
    const [subscriber] = await tx.select().from(subscribers).where(eq(subscribers.id, input.subscriberId));
    if (!subscriber) throw new BatchError("SUBSCRIBER_NOT_FOUND", 404, "Subscriber not found.");
    if (subscriber.status === "archived") {
      throw new BatchError("SUBSCRIBER_ARCHIVED", 409, `${subscriber.accountNumber} is archived.`);
    }

    await lockLiveBatchMembership(tx);
    const onBatch = (await liveBatchOf(tx, [subscriber.id])).get(subscriber.id);
    if (onBatch === batch.batchNumber) {
      throw new BatchError("ALREADY_ON_BATCH", 409, `${subscriber.accountNumber} is already on this batch.`);
    }
    if (onBatch) {
      throw new BatchError("ON_ANOTHER_BATCH", 409, `${subscriber.accountNumber} is already on batch ${onBatch}.`);
    }

    const snapshot = (await snapshotsFor(tx, [subscriber.id], await dbToday(tx))).get(subscriber.id)!;
    await tx.insert(batchAccounts).values({ batchId, subscriberId: subscriber.id, addedByUserId: actorUserId, ...snapshot });
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.add_account",
      entityType: "collection_batch",
      entityId: batchId,
      newValues: { batchNumber: batch.batchNumber, accountNumber: subscriber.accountNumber, ...snapshot },
    });
  });
  return getBatch(db, batchId);
}

/** Takes a subscriber off the route sheet. Only while the batch is still open. */
export async function removeBatchAccount(
  db: Db,
  actorUserId: string,
  batchId: string,
  subscriberId: string,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.status !== "open") {
      throw new BatchError("BATCH_NOT_EDITABLE", 409, "Accounts can only be removed while the batch is open.");
    }
    const [removed] = await tx
      .delete(batchAccounts)
      .where(and(eq(batchAccounts.batchId, batchId), eq(batchAccounts.subscriberId, subscriberId)))
      .returning();
    if (!removed) throw new BatchError("NOT_ON_BATCH", 404, "That subscriber is not on this batch.");

    const [subscriber] = await tx
      .select({ accountNumber: subscribers.accountNumber })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.remove_account",
      entityType: "collection_batch",
      entityId: batchId,
      oldValues: {
        batchNumber: batch.batchNumber,
        accountNumber: subscriber?.accountNumber,
        totalDueCentavos: removed.totalDueCentavos,
      },
    });
  });
  return getBatch(db, batchId);
}

/* ------------------------------ Lifecycle ------------------------------ */

/** The collector leaves with the route sheet. Collections can be recorded from now on. */
export async function dispatchBatch(db: Db, actorUserId: string, batchId: string): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    ensureTransition(batch, "in_progress");
    const [accounts] = await tx.select({ value: count() }).from(batchAccounts).where(eq(batchAccounts.batchId, batchId));
    if ((accounts?.value ?? 0) === 0) {
      throw new BatchError("BATCH_EMPTY", 409, "Add at least one account before dispatching the batch.");
    }
    await tx
      .update(collectionBatches)
      .set({ status: "in_progress", dispatchedAt: sql`now()`, dispatchedByUserId: actorUserId })
      .where(eq(collectionBatches.id, batchId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.dispatch",
      entityType: "collection_batch",
      entityId: batchId,
      oldValues: { status: batch.status },
      newValues: { status: "in_progress" },
    });
  });
  return getBatch(db, batchId);
}

/** The collector is back and every collection is entered. No more collections after this. */
export async function submitBatch(db: Db, actorUserId: string, batchId: string): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    ensureTransition(batch, "submitted");
    await tx
      .update(collectionBatches)
      .set({ status: "submitted", submittedAt: sql`now()`, submittedByUserId: actorUserId })
      .where(eq(collectionBatches.id, batchId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.submit",
      entityType: "collection_batch",
      entityId: batchId,
      oldValues: { status: batch.status },
      newValues: { status: "submitted" },
    });
  });
  return getBatch(db, batchId);
}

/** Calls the round off. Only before submission and while nothing has been collected. */
export async function cancelBatch(
  db: Db,
  actorUserId: string,
  batchId: string,
  input: BatchCancelInput,
): Promise<BatchDetail> {
  await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    ensureTransition(batch, "cancelled");
    const [collected] = await tx.select({ value: count() }).from(payments).where(eq(payments.collectionBatchId, batchId));
    if ((collected?.value ?? 0) > 0) {
      throw new BatchError(
        "HAS_COLLECTIONS",
        409,
        "Collections are already recorded on this batch, so it cannot be cancelled. Submit it instead.",
      );
    }
    await tx
      .update(collectionBatches)
      .set({ status: "cancelled", cancelledAt: sql`now()`, cancelledByUserId: actorUserId, cancelReason: input.reason })
      .where(eq(collectionBatches.id, batchId));
    await writeAudit(tx, {
      actorUserId,
      action: "collection_batch.cancel",
      entityType: "collection_batch",
      entityId: batchId,
      reason: input.reason,
      oldValues: { status: batch.status },
      newValues: { status: "cancelled" },
    });
  });
  return getBatch(db, batchId);
}

/* ------------------------------- Reading ------------------------------- */

export interface BatchAccountRow {
  subscriberId: string;
  accountNumber: string;
  fullName: string;
  subscriberStatus: string;
  areaCode: string | null;
  /** The subscriber's primary address, for the route sheet. */
  addressLine: string | null;
  barangay: string | null;
  city: string | null;
  landmark: string | null;
  currentCentavos: number;
  arrearsCentavos: number;
  creditCentavos: number;
  totalDueCentavos: number;
  addedAt: Date;
  /** Added after the collector was dispatched. */
  addedLate: boolean;
}

/** Who did a lifecycle step, and when. */
export interface BatchStep {
  at: Date;
  byName: string;
}

export interface BatchDetail {
  id: string;
  batchNumber: string;
  status: CollectionBatchStatus;
  collectionDate: string;
  notes: string | null;
  collector: { id: string; code: string; fullName: string };
  area: { id: string; code: string; name: string } | null;
  created: BatchStep;
  dispatched: BatchStep | null;
  submitted: BatchStep | null;
  reconciled: BatchStep | null;
  closed: BatchStep | null;
  cancelled: (BatchStep & { reason: string }) | null;
  /** Route sheet order: area, barangay, street, name. */
  accounts: BatchAccountRow[];
  totals: { accountCount: number; currentCentavos: number; arrearsCentavos: number; totalDueCentavos: number };
}

export async function getBatch(executor: DbOrTx, batchId: string): Promise<BatchDetail> {
  const [row] = await executor
    .select({
      batch: collectionBatches,
      collector: { id: collectors.id, code: collectors.code, fullName: collectors.fullName },
      area: { id: collectionAreas.id, code: collectionAreas.code, name: collectionAreas.name },
    })
    .from(collectionBatches)
    .innerJoin(collectors, eq(collectors.id, collectionBatches.collectorId))
    .leftJoin(collectionAreas, eq(collectionAreas.id, collectionBatches.collectionAreaId))
    .where(eq(collectionBatches.id, batchId));
  if (!row) throw new BatchError("BATCH_NOT_FOUND", 404, "Collection batch not found.");
  const b = row.batch;

  const userIds = [
    b.createdByUserId,
    b.dispatchedByUserId,
    b.submittedByUserId,
    b.reconciledByUserId,
    b.closedByUserId,
    b.cancelledByUserId,
  ].filter((id): id is string => id !== null);
  const names = new Map(
    (await executor.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds))).map(
      (u) => [u.id, u.fullName],
    ),
  );
  const step = (at: Date | null, by: string | null): BatchStep | null =>
    at && by ? { at, byName: names.get(by) ?? "Unknown user" } : null;

  const accountRows = await executor
    .select({
      subscriberId: batchAccounts.subscriberId,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      subscriberStatus: subscribers.status,
      areaCode: collectionAreas.code,
      addressLine: subscriberAddresses.line1,
      barangay: subscriberAddresses.barangay,
      city: subscriberAddresses.city,
      landmark: subscriberAddresses.landmark,
      currentCentavos: batchAccounts.currentCentavos,
      arrearsCentavos: batchAccounts.arrearsCentavos,
      creditCentavos: batchAccounts.creditCentavos,
      totalDueCentavos: batchAccounts.totalDueCentavos,
      addedAt: batchAccounts.addedAt,
    })
    .from(batchAccounts)
    .innerJoin(subscribers, eq(subscribers.id, batchAccounts.subscriberId))
    .leftJoin(collectionAreas, eq(collectionAreas.id, subscribers.collectionAreaId))
    .leftJoin(
      subscriberAddresses,
      and(eq(subscriberAddresses.subscriberId, subscribers.id), eq(subscriberAddresses.isPrimary, true)),
    )
    .where(eq(batchAccounts.batchId, batchId))
    .orderBy(
      sql`${collectionAreas.code} NULLS LAST`,
      asc(subscriberAddresses.barangay),
      asc(subscriberAddresses.line1),
      asc(subscribers.fullName),
    );

  const accounts = accountRows.map((a) => ({
    ...a,
    addedLate: b.dispatchedAt !== null && a.addedAt > b.dispatchedAt,
  }));
  const sum = (pick: (a: BatchAccountRow) => number) => accounts.reduce((total, a) => total + pick(a), 0);

  return {
    id: b.id,
    batchNumber: b.batchNumber,
    status: b.status as CollectionBatchStatus,
    collectionDate: b.collectionDate,
    notes: b.notes,
    collector: row.collector,
    area: row.area,
    created: step(b.createdAt, b.createdByUserId)!,
    dispatched: step(b.dispatchedAt, b.dispatchedByUserId),
    submitted: step(b.submittedAt, b.submittedByUserId),
    reconciled: step(b.reconciledAt, b.reconciledByUserId),
    closed: step(b.closedAt, b.closedByUserId),
    cancelled:
      b.cancelledAt && b.cancelledByUserId
        ? { ...step(b.cancelledAt, b.cancelledByUserId)!, reason: b.cancelReason ?? "" }
        : null,
    accounts,
    totals: {
      accountCount: accounts.length,
      currentCentavos: sum((a) => a.currentCentavos),
      arrearsCentavos: sum((a) => a.arrearsCentavos),
      totalDueCentavos: sum((a) => a.totalDueCentavos),
    },
  };
}

export interface BatchListItem {
  id: string;
  batchNumber: string;
  status: CollectionBatchStatus;
  collectionDate: string;
  collectorCode: string;
  collectorName: string;
  areaCode: string | null;
  accountCount: number;
  totalDueCentavos: number;
}

export interface BatchPage {
  items: BatchListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Collection Batches list: newest collection date first. */
export async function listBatches(db: Db, query: BatchListQuery): Promise<BatchPage> {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(collectionBatches.status, query.status));
  if (query.collectorId) filters.push(eq(collectionBatches.collectorId, query.collectorId));
  if (query.from) filters.push(gte(collectionBatches.collectionDate, query.from));
  if (query.to) filters.push(lte(collectionBatches.collectionDate, query.to));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await db.select({ value: count() }).from(collectionBatches).where(where);
  const items = await db
    .select({
      id: collectionBatches.id,
      batchNumber: collectionBatches.batchNumber,
      status: sql<CollectionBatchStatus>`${collectionBatches.status}`,
      collectionDate: collectionBatches.collectionDate,
      collectorCode: collectors.code,
      collectorName: collectors.fullName,
      areaCode: collectionAreas.code,
      accountCount: sql<number>`(SELECT count(*) FROM batch_accounts ba WHERE ba.batch_id = ${collectionBatches.id})::int`,
      totalDueCentavos: sql<number>`(SELECT coalesce(sum(ba.total_due_centavos), 0) FROM batch_accounts ba WHERE ba.batch_id = ${collectionBatches.id})::int`,
    })
    .from(collectionBatches)
    .innerJoin(collectors, eq(collectors.id, collectionBatches.collectorId))
    .leftJoin(collectionAreas, eq(collectionAreas.id, collectionBatches.collectionAreaId))
    .where(where)
    .orderBy(desc(collectionBatches.collectionDate), desc(collectionBatches.batchNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { items, total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize };
}
