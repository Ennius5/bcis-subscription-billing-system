import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  daysPastDue,
  reconnectionPaymentProblem,
  reconnectionTransitionProblem,
  type OpenInvoiceAge,
  type ReconnectionAssignInput,
  type ReconnectionCancelInput,
  type ReconnectionCompleteInput,
  type ReconnectionRequestInput,
  type ReconnectionStatus,
  type ServiceSuspendInput,
} from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { dbToday, type Tx } from "../db/query_helpers";
import {
  reconnectionRecords,
  roles,
  serviceAccounts,
  servicePlans,
  suspensionRecords,
  userRoles,
  users,
} from "../db/schema";
import {
  fetchServiceAccount,
  lockAccount,
  recordChange,
  type ServiceAccountDetail,
} from "../service-accounts/service";

/*
 * Suspension and reconnection (spec 3.10), as decided for this project:
 * - Suspending is a manual, approved action on an active service (the candidate list is advice).
 * - A reconnection can be requested once no past-due invoice of that service is open; it is
 *   checked again on completion, in case a payment was reversed in between.
 * - Completing the reconnection makes the service active again. Its fee (the plan's, unless
 *   waived) is billed on the next generated invoice.
 * Every step writes a service event and an audit row in the same transaction. Lock order is
 * always the service account first, then the reconnection.
 */

export class ServiceControlError extends Error {
  constructor(
    public readonly code:
      | "NOT_ACTIVE"
      | "NOT_SUSPENDED"
      | "NO_SUSPENSION"
      | "PAYMENT_REQUIRED"
      | "RECONNECTION_IN_PROGRESS"
      | "RECONNECTION_NOT_FOUND"
      | "INVALID_TRANSITION"
      | "INVALID_DATE"
      | "TECHNICIAN_NOT_FOUND",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------- Helpers ------------------------------- */

function assertNotFuture(date: string, today: string, what: string): void {
  if (date > today) throw new ServiceControlError("INVALID_DATE", 422, `The ${what} cannot be in the future.`);
}

/** Open invoices of one service account, for the qualifying-payment rule and the snapshot. */
async function openInvoices(tx: DbOrTx, serviceAccountId: string): Promise<OpenInvoiceAge[]> {
  const result = await tx.execute<{ due_date: string; open_centavos: number }>(sql`
    SELECT due_date::text AS due_date, (total_centavos + adjusted_centavos - paid_centavos) AS open_centavos
    FROM invoices
    WHERE service_account_id = ${serviceAccountId} AND status IN ('unpaid', 'partially_paid')
      AND total_centavos + adjusted_centavos - paid_centavos > 0
  `);
  return result.rows.map((r) => ({ dueDate: r.due_date, openCentavos: r.open_centavos }));
}

async function assertPaymentQualifies(tx: Tx, serviceAccountId: string, today: string): Promise<void> {
  const problem = reconnectionPaymentProblem(await openInvoices(tx, serviceAccountId), today);
  if (problem) {
    throw new ServiceControlError("PAYMENT_REQUIRED", 409, `${problem} Collect the arrears before reconnecting.`);
  }
}

/** An active user with the technician role. */
async function assertTechnician(tx: Tx, userId: string): Promise<void> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.id, userId), eq(users.isActive, true), eq(roles.code, "technician")))
    .limit(1);
  if (!row) throw new ServiceControlError("TECHNICIAN_NOT_FOUND", 422, "Choose an active technician.");
}

/** Locks the service account, then the reconnection (the order every function here uses). */
async function lockReconnection(tx: Tx, reconnectionId: string) {
  const [ref] = await tx
    .select({ serviceAccountId: reconnectionRecords.serviceAccountId })
    .from(reconnectionRecords)
    .where(eq(reconnectionRecords.id, reconnectionId))
    .limit(1);
  if (!ref) throw new ServiceControlError("RECONNECTION_NOT_FOUND", 404, "Reconnection not found.");
  const account = await lockAccount(tx, ref.serviceAccountId);
  const [reconnection] = await tx
    .select()
    .from(reconnectionRecords)
    .where(eq(reconnectionRecords.id, reconnectionId))
    .for("update");
  if (!reconnection) throw new ServiceControlError("RECONNECTION_NOT_FOUND", 404, "Reconnection not found.");
  return { account, reconnection };
}

function assertTransition(from: string, to: ReconnectionStatus): void {
  const problem = reconnectionTransitionProblem(from as ReconnectionStatus, to);
  if (problem) throw new ServiceControlError("INVALID_TRANSITION", 409, problem);
}

/* ------------------------------- Suspend ------------------------------- */

/**
 * Suspends an active service: suspension record (with the past-due snapshot), status,
 * service event and audit row, all in one transaction. Billing skips suspended accounts.
 */
export async function suspendService(
  db: Db,
  actorUserId: string,
  serviceAccountId: string,
  input: ServiceSuspendInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, serviceAccountId);
    if (account.status !== "active") {
      throw new ServiceControlError("NOT_ACTIVE", 409, `Only an active service can be suspended; this one is ${account.status}.`);
    }
    const today = await dbToday(tx);
    const effectiveDate = input.effectiveDate ?? today;
    assertNotFuture(effectiveDate, today, "effective date");

    const pastDue = (await openInvoices(tx, serviceAccountId)).filter((i) => daysPastDue(i.dueDate, today) > 0);
    const [record] = await tx
      .insert(suspensionRecords)
      .values({
        serviceAccountId,
        effectiveDate,
        reason: input.reason,
        approvedBy: input.approvedBy,
        notes: input.notes ?? null,
        pastDueInvoiceCount: pastDue.length,
        pastDueCentavos: pastDue.reduce((t, i) => t + i.openCentavos, 0),
        suspendedByUserId: actorUserId,
      })
      .returning({ id: suspensionRecords.id });
    if (!record) throw new Error("Failed to record the suspension");

    await tx
      .update(serviceAccounts)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(serviceAccounts.id, serviceAccountId));

    await recordChange(tx, "service_account.suspend", {
      serviceAccountId,
      actorUserId,
      eventType: "status_change",
      fromStatus: "active",
      toStatus: "suspended",
      oldValues: { status: "active" },
      newValues: {
        status: "suspended",
        suspensionId: record.id,
        approvedBy: input.approvedBy,
        pastDueInvoiceCount: pastDue.length,
      },
      effectiveDate,
      reason: input.reason,
    });
    return fetchServiceAccount(tx, serviceAccountId);
  });
}

/* ------------------------------ Reconnection ------------------------------ */

/**
 * Starts a reconnection for a suspended service once its arrears are paid. The fee is the
 * plan's reconnection fee at this moment; waiving it needs a reason.
 */
export async function requestReconnection(
  db: Db,
  actorUserId: string,
  serviceAccountId: string,
  input: ReconnectionRequestInput,
): Promise<ReconnectionDetail> {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, serviceAccountId);
    if (account.status !== "suspended") {
      throw new ServiceControlError(
        "NOT_SUSPENDED",
        409,
        `Only a suspended service can be reconnected; this one is ${account.status}.`,
      );
    }
    const [live] = await tx
      .select({ id: reconnectionRecords.id })
      .from(reconnectionRecords)
      .where(
        and(
          eq(reconnectionRecords.serviceAccountId, serviceAccountId),
          sql`${reconnectionRecords.status} IN ('requested', 'assigned')`,
        ),
      )
      .limit(1);
    if (live) {
      throw new ServiceControlError("RECONNECTION_IN_PROGRESS", 409, "A reconnection is already open for this service.");
    }
    const [suspension] = await tx
      .select({ id: suspensionRecords.id, effectiveDate: suspensionRecords.effectiveDate })
      .from(suspensionRecords)
      .where(eq(suspensionRecords.serviceAccountId, serviceAccountId))
      .orderBy(desc(suspensionRecords.createdAt))
      .limit(1);
    // Accounts suspended before Phase 7 have no suspension record to lift.
    if (!suspension) {
      throw new ServiceControlError("NO_SUSPENSION", 409, "This service has no suspension record to reconnect from.");
    }

    const today = await dbToday(tx);
    const requestDate = input.requestDate ?? today;
    assertNotFuture(requestDate, today, "request date");
    if (requestDate < suspension.effectiveDate) {
      throw new ServiceControlError("INVALID_DATE", 422, "The request date cannot be before the suspension.");
    }
    await assertPaymentQualifies(tx, serviceAccountId, today);

    const [plan] = await tx
      .select({ fee: servicePlans.reconnectionFeeCentavos })
      .from(servicePlans)
      .where(eq(servicePlans.id, account.planId))
      .limit(1);
    const feeCentavos = plan?.fee ?? 0;
    const feeWaiverReason = input.waiveFee ? (input.feeWaiverReason ?? null) : null;

    const [created] = await tx
      .insert(reconnectionRecords)
      .values({
        serviceAccountId,
        suspensionRecordId: suspension.id,
        requestDate,
        requestedByUserId: actorUserId,
        feeCentavos,
        feeWaived: input.waiveFee,
        feeWaiverReason,
        notes: input.notes ?? null,
      })
      .returning({ id: reconnectionRecords.id });
    if (!created) throw new Error("Failed to create the reconnection");

    await recordChange(tx, "service_account.reconnection_request", {
      serviceAccountId,
      actorUserId,
      eventType: "reconnection_request",
      newValues: { reconnectionId: created.id, feeCentavos, feeWaived: input.waiveFee, feeWaiverReason },
      effectiveDate: requestDate,
      reason: feeWaiverReason,
    });
    return fetchReconnection(tx, created.id);
  });
}

/** Assigns (or hands over) the job to a technician. The same technician again changes nothing. */
export async function assignReconnection(
  db: Db,
  actorUserId: string,
  reconnectionId: string,
  input: ReconnectionAssignInput,
): Promise<ReconnectionDetail> {
  return db.transaction(async (tx) => {
    const { reconnection } = await lockReconnection(tx, reconnectionId);
    assertTransition(reconnection.status, "assigned");
    if (reconnection.technicianUserId === input.technicianUserId) return fetchReconnection(tx, reconnectionId);
    await assertTechnician(tx, input.technicianUserId);

    await tx
      .update(reconnectionRecords)
      .set({
        status: "assigned",
        technicianUserId: input.technicianUserId,
        assignedByUserId: actorUserId,
        assignedAt: new Date(),
      })
      .where(eq(reconnectionRecords.id, reconnectionId));

    await recordChange(tx, "service_account.reconnection_assign", {
      serviceAccountId: reconnection.serviceAccountId,
      actorUserId,
      eventType: "reconnection_assign",
      oldValues: { reconnectionId, technicianUserId: reconnection.technicianUserId },
      newValues: { reconnectionId, technicianUserId: input.technicianUserId },
    });
    return fetchReconnection(tx, reconnectionId);
  });
}

/**
 * Completes the reconnection: the service is active again. The payment rule is checked
 * again here, because a payment may have been reversed since the request.
 */
export async function completeReconnection(
  db: Db,
  actorUserId: string,
  reconnectionId: string,
  input: ReconnectionCompleteInput,
): Promise<ReconnectionDetail> {
  return db.transaction(async (tx) => {
    const { account, reconnection } = await lockReconnection(tx, reconnectionId);
    assertTransition(reconnection.status, "completed");
    if (account.status !== "suspended") {
      throw new ServiceControlError("NOT_SUSPENDED", 409, `The service is ${account.status}, not suspended.`);
    }
    const today = await dbToday(tx);
    const completionDate = input.completionDate ?? today;
    assertNotFuture(completionDate, today, "completion date");
    if (completionDate < reconnection.requestDate) {
      throw new ServiceControlError("INVALID_DATE", 422, "The completion date cannot be before the request date.");
    }
    await assertPaymentQualifies(tx, account.id, today);

    await tx
      .update(reconnectionRecords)
      .set({ status: "completed", completionDate, completedByUserId: actorUserId, completedAt: new Date() })
      .where(eq(reconnectionRecords.id, reconnectionId));
    await tx
      .update(serviceAccounts)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(serviceAccounts.id, account.id));

    await recordChange(tx, "service_account.reconnect", {
      serviceAccountId: account.id,
      actorUserId,
      eventType: "status_change",
      fromStatus: "suspended",
      toStatus: "active",
      oldValues: { status: "suspended" },
      newValues: { status: "active", reconnectionId, feeCentavos: reconnection.feeWaived ? 0 : reconnection.feeCentavos },
      effectiveDate: completionDate,
    });
    return fetchReconnection(tx, reconnectionId);
  });
}

/** Cancels an open reconnection; the service stays suspended and a new one can be requested. */
export async function cancelReconnection(
  db: Db,
  actorUserId: string,
  reconnectionId: string,
  input: ReconnectionCancelInput,
): Promise<ReconnectionDetail> {
  return db.transaction(async (tx) => {
    const { reconnection } = await lockReconnection(tx, reconnectionId);
    assertTransition(reconnection.status, "cancelled");

    await tx
      .update(reconnectionRecords)
      .set({ status: "cancelled", cancelReason: input.reason, cancelledByUserId: actorUserId, cancelledAt: new Date() })
      .where(eq(reconnectionRecords.id, reconnectionId));

    await recordChange(tx, "service_account.reconnection_cancel", {
      serviceAccountId: reconnection.serviceAccountId,
      actorUserId,
      eventType: "reconnection_cancel",
      oldValues: { reconnectionId, status: reconnection.status },
      newValues: { reconnectionId, status: "cancelled" },
      reason: input.reason,
    });
    return fetchReconnection(tx, reconnectionId);
  });
}

/* -------------------------------- Reading -------------------------------- */

const requestedBy = alias(users, "requested_by");
const technician = alias(users, "technician");
const completedBy = alias(users, "completed_by");
const cancelledBy = alias(users, "cancelled_by");
const suspendedBy = alias(users, "suspended_by");

function selectReconnections(executor: DbOrTx) {
  return executor
    .select({
      id: reconnectionRecords.id,
      serviceAccountId: reconnectionRecords.serviceAccountId,
      suspensionRecordId: reconnectionRecords.suspensionRecordId,
      status: reconnectionRecords.status,
      requestDate: reconnectionRecords.requestDate,
      requestedByName: requestedBy.fullName,
      requestedAt: reconnectionRecords.requestedAt,
      feeCentavos: reconnectionRecords.feeCentavos,
      feeWaived: reconnectionRecords.feeWaived,
      feeWaiverReason: reconnectionRecords.feeWaiverReason,
      notes: reconnectionRecords.notes,
      technicianUserId: reconnectionRecords.technicianUserId,
      technicianName: technician.fullName,
      assignedAt: reconnectionRecords.assignedAt,
      completionDate: reconnectionRecords.completionDate,
      completedByName: completedBy.fullName,
      completedAt: reconnectionRecords.completedAt,
      cancelReason: reconnectionRecords.cancelReason,
      cancelledByName: cancelledBy.fullName,
      cancelledAt: reconnectionRecords.cancelledAt,
    })
    .from(reconnectionRecords)
    .innerJoin(requestedBy, eq(requestedBy.id, reconnectionRecords.requestedByUserId))
    .leftJoin(technician, eq(technician.id, reconnectionRecords.technicianUserId))
    .leftJoin(completedBy, eq(completedBy.id, reconnectionRecords.completedByUserId))
    .leftJoin(cancelledBy, eq(cancelledBy.id, reconnectionRecords.cancelledByUserId));
}

export type ReconnectionDetail = Awaited<ReturnType<ReturnType<typeof selectReconnections>["execute"]>>[number];

async function fetchReconnection(executor: DbOrTx, id: string): Promise<ReconnectionDetail> {
  const [row] = await selectReconnections(executor).where(eq(reconnectionRecords.id, id)).limit(1);
  if (!row) throw new ServiceControlError("RECONNECTION_NOT_FOUND", 404, "Reconnection not found.");
  return row;
}

export async function getReconnection(db: Db, id: string): Promise<ReconnectionDetail> {
  return fetchReconnection(db, id);
}

export interface SuspensionRow {
  id: string;
  effectiveDate: string;
  reason: string;
  approvedBy: string;
  notes: string | null;
  pastDueInvoiceCount: number;
  pastDueCentavos: number;
  suspendedByName: string;
  createdAt: Date;
}

export interface ServiceControlHistory {
  suspensions: SuspensionRow[];
  reconnections: ReconnectionDetail[];
}

/** Suspension and reconnection history of one service account, newest first. */
export async function getServiceControlHistory(db: Db, serviceAccountId: string): Promise<ServiceControlHistory> {
  const suspensions = await db
    .select({
      id: suspensionRecords.id,
      effectiveDate: suspensionRecords.effectiveDate,
      reason: suspensionRecords.reason,
      approvedBy: suspensionRecords.approvedBy,
      notes: suspensionRecords.notes,
      pastDueInvoiceCount: suspensionRecords.pastDueInvoiceCount,
      pastDueCentavos: suspensionRecords.pastDueCentavos,
      suspendedByName: suspendedBy.fullName,
      createdAt: suspensionRecords.createdAt,
    })
    .from(suspensionRecords)
    .innerJoin(suspendedBy, eq(suspendedBy.id, suspensionRecords.suspendedByUserId))
    .where(eq(suspensionRecords.serviceAccountId, serviceAccountId))
    .orderBy(desc(suspensionRecords.createdAt));
  const reconnections = await selectReconnections(db)
    .where(eq(reconnectionRecords.serviceAccountId, serviceAccountId))
    .orderBy(desc(reconnectionRecords.requestedAt));
  return { suspensions, reconnections };
}

/** Active technicians, for the assignment picker. */
export async function listTechnicians(db: Db): Promise<Array<{ id: string; fullName: string; username: string }>> {
  return db
    .selectDistinct({ id: users.id, fullName: users.fullName, username: users.username })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.isActive, true), eq(roles.code, "technician")))
    .orderBy(users.fullName);
}
