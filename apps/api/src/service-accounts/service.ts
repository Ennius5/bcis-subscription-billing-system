import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  serviceStatusChangeProblem,
  type ServiceAccountCreateInput,
  type ServiceAccountListQuery,
  type ServiceAccountStatus,
  type ServiceAccountUpdateInput,
  type ServiceCollectorChangeInput,
  type ServicePlanChangeInput,
  type ServiceRateChangeInput,
  type ServiceStatusChangeInput,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { changedFields, likePattern, type Tx } from "../db/query_helpers";
import {
  collectors,
  serviceAccounts,
  serviceEvents,
  servicePlans,
  serviceTypes,
  subscriberAddresses,
  subscribers,
  users,
} from "../db/schema";

export class ServiceAccountError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "SUBSCRIBER_NOT_FOUND"
      | "SUBSCRIBER_CLOSED"
      | "PLAN_NOT_FOUND"
      | "PLAN_INACTIVE"
      | "SAME_PLAN"
      | "ADDRESS_NOT_FOUND"
      | "ADDRESS_INACTIVE"
      | "COLLECTOR_NOT_FOUND"
      | "COLLECTOR_INACTIVE"
      | "INVALID_STATUS_CHANGE"
      | "INVALID_DATE"
      | "ACCOUNT_TERMINATED",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------- Reading ------------------------------- */

// The collector shown is the account's override when set, otherwise the subscriber's.
const overrideCollector = alias(collectors, "override_collector");
const subscriberCollector = alias(collectors, "subscriber_collector");

const accountFields = {
  id: serviceAccounts.id,
  serviceNumber: serviceAccounts.serviceNumber,
  status: serviceAccounts.status,
  subscriberId: serviceAccounts.subscriberId,
  accountNumber: subscribers.accountNumber,
  subscriberName: subscribers.fullName,
  subscriberStatus: subscribers.status,
  planId: serviceAccounts.planId,
  planCode: servicePlans.code,
  planName: servicePlans.name,
  planPriceCentavos: servicePlans.priceCentavos,
  serviceType: serviceTypes.code,
  currentRateCentavos: serviceAccounts.currentRateCentavos,
  billingDay: serviceAccounts.billingDay,
  activationDate: serviceAccounts.activationDate,
  billingStartDate: serviceAccounts.billingStartDate,
  installationAddressId: serviceAccounts.installationAddressId,
  addressLine1: subscriberAddresses.line1,
  addressBarangay: subscriberAddresses.barangay,
  addressCity: subscriberAddresses.city,
  assignedCollectorId: serviceAccounts.assignedCollectorId,
  collectorCode: sql<string | null>`coalesce(${overrideCollector.code}, ${subscriberCollector.code})`,
  collectorName: sql<string | null>`coalesce(${overrideCollector.fullName}, ${subscriberCollector.fullName})`,
  notes: serviceAccounts.notes,
  createdAt: serviceAccounts.createdAt,
  updatedAt: serviceAccounts.updatedAt,
};

/** Service accounts joined with everything the list and detail show. */
function selectAccounts(executor: DbOrTx) {
  return executor
    .select(accountFields)
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .innerJoin(subscriberAddresses, eq(serviceAccounts.installationAddressId, subscriberAddresses.id))
    .leftJoin(overrideCollector, eq(serviceAccounts.assignedCollectorId, overrideCollector.id))
    .leftJoin(subscriberCollector, eq(subscribers.assignedCollectorId, subscriberCollector.id));
}

export type ServiceAccountRow = Awaited<ReturnType<ReturnType<typeof selectAccounts>["execute"]>>[number];

export type ServiceAccountPage = {
  items: ServiceAccountRow[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listServiceAccounts(db: Db, query: ServiceAccountListQuery): Promise<ServiceAccountPage> {
  const where = and(
    query.subscriberId ? eq(serviceAccounts.subscriberId, query.subscriberId) : undefined,
    query.status ? eq(serviceAccounts.status, query.status) : undefined,
    query.planId ? eq(serviceAccounts.planId, query.planId) : undefined,
    query.serviceType ? eq(serviceTypes.code, query.serviceType) : undefined,
    query.search
      ? or(
          ilike(serviceAccounts.serviceNumber, likePattern(query.search)),
          ilike(subscribers.accountNumber, likePattern(query.search)),
          ilike(subscribers.fullName, likePattern(query.search)),
        )
      : undefined,
  );

  const itemsQuery = selectAccounts(db)
    .where(where)
    .orderBy(asc(serviceAccounts.serviceNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  // The filters touch subscribers and service types, so the count keeps those joins.
  const totalQuery = db
    .select({ value: count() })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(where);

  const [items, [totalRow]] = await Promise.all([itemsQuery, totalQuery]);
  return { items, total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

export type ServiceEventRow = {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  oldValues: unknown;
  newValues: unknown;
  effectiveDate: string;
  reason: string | null;
  actorUsername: string | null;
  actorName: string | null;
  occurredAt: Date;
};

export type ServiceAccountDetail = ServiceAccountRow & { events: ServiceEventRow[] };

async function fetchServiceAccount(executor: DbOrTx, id: string): Promise<ServiceAccountDetail> {
  const [account] = await selectAccounts(executor).where(eq(serviceAccounts.id, id)).limit(1);
  if (!account) throw new ServiceAccountError("NOT_FOUND", 404, "Service account not found.");

  const events = await executor
    .select({
      id: serviceEvents.id,
      eventType: serviceEvents.eventType,
      fromStatus: serviceEvents.fromStatus,
      toStatus: serviceEvents.toStatus,
      oldValues: serviceEvents.oldValues,
      newValues: serviceEvents.newValues,
      effectiveDate: serviceEvents.effectiveDate,
      reason: serviceEvents.reason,
      actorUsername: users.username,
      actorName: users.fullName,
      occurredAt: serviceEvents.occurredAt,
    })
    .from(serviceEvents)
    .leftJoin(users, eq(serviceEvents.actorUserId, users.id))
    .where(eq(serviceEvents.serviceAccountId, id))
    .orderBy(desc(serviceEvents.occurredAt), desc(serviceEvents.id));

  return { ...account, events };
}

export async function getServiceAccount(db: Db, id: string): Promise<ServiceAccountDetail> {
  return fetchServiceAccount(db, id);
}

/* ------------------------------- Helpers ------------------------------- */

/** Today's date by the database clock, the same clock the date CHECK constraints use. */
async function dbToday(tx: Tx): Promise<string> {
  const result = await tx.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`);
  const today = result.rows[0]?.today;
  if (!today) throw new Error("Could not read the database date");
  return today;
}

async function lockAccount(tx: Tx, id: string) {
  const [account] = await tx.select().from(serviceAccounts).where(eq(serviceAccounts.id, id)).for("update");
  if (!account) throw new ServiceAccountError("NOT_FOUND", 404, "Service account not found.");
  return account;
}

/** Terminated is final, so the account is read-only. */
function assertNotTerminated(account: { status: string; serviceNumber: string }): void {
  if (account.status === "terminated") {
    throw new ServiceAccountError(
      "ACCOUNT_TERMINATED",
      409,
      `Service account ${account.serviceNumber} is terminated and can no longer be changed.`,
    );
  }
}

async function activePlan(tx: Tx, planId: string) {
  const [plan] = await tx
    .select({ code: servicePlans.code, priceCentavos: servicePlans.priceCentavos, isActive: servicePlans.isActive })
    .from(servicePlans)
    .where(eq(servicePlans.id, planId))
    .limit(1);
  if (!plan) throw new ServiceAccountError("PLAN_NOT_FOUND", 422, "The selected plan does not exist.");
  if (!plan.isActive) {
    throw new ServiceAccountError("PLAN_INACTIVE", 422, `Plan ${plan.code} is inactive and cannot be chosen.`);
  }
  return plan;
}

async function assertAddress(tx: Tx, subscriberId: string, addressId: string): Promise<void> {
  const [address] = await tx
    .select({ isActive: subscriberAddresses.isActive })
    .from(subscriberAddresses)
    .where(and(eq(subscriberAddresses.id, addressId), eq(subscriberAddresses.subscriberId, subscriberId)))
    .limit(1);
  if (!address) {
    throw new ServiceAccountError("ADDRESS_NOT_FOUND", 422, "The address does not belong to this subscriber.");
  }
  if (!address.isActive) {
    throw new ServiceAccountError("ADDRESS_INACTIVE", 422, "The selected address is inactive.");
  }
}

async function assertCollector(tx: Tx, collectorId: string): Promise<void> {
  const [collector] = await tx
    .select({ code: collectors.code, isActive: collectors.isActive })
    .from(collectors)
    .where(eq(collectors.id, collectorId))
    .limit(1);
  if (!collector) {
    throw new ServiceAccountError("COLLECTOR_NOT_FOUND", 422, "The selected collector does not exist.");
  }
  if (!collector.isActive) {
    throw new ServiceAccountError("COLLECTOR_INACTIVE", 422, `Collector ${collector.code} is inactive.`);
  }
}

type EventInput = {
  serviceAccountId: string;
  actorUserId: string;
  eventType: "created" | "status_change" | "rate_change" | "plan_change" | "collector_change" | "update";
  fromStatus?: string | null;
  toStatus?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  effectiveDate?: string;
  reason?: string | null;
};

/** Every change writes the service history row and the audit row in the same transaction. */
async function recordChange(tx: Tx, action: string, event: EventInput): Promise<void> {
  await tx.insert(serviceEvents).values({
    serviceAccountId: event.serviceAccountId,
    actorUserId: event.actorUserId,
    eventType: event.eventType,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    oldValues: event.oldValues ?? null,
    newValues: event.newValues ?? null,
    ...(event.effectiveDate ? { effectiveDate: event.effectiveDate } : {}),
    reason: event.reason ?? null,
  });
  await writeAudit(tx, {
    actorUserId: event.actorUserId,
    action,
    entityType: "service_account",
    entityId: event.serviceAccountId,
    reason: event.reason ?? null,
    oldValues: event.oldValues ?? null,
    newValues: event.newValues ?? null,
  });
}

/* ------------------------------- Create ------------------------------- */

export async function createServiceAccount(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: ServiceAccountCreateInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    // Locked so the address checks below cannot race an address change on the same subscriber.
    const [subscriber] = await tx
      .select({ status: subscribers.status, billingDay: subscribers.billingDay })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for("update");
    if (!subscriber) throw new ServiceAccountError("SUBSCRIBER_NOT_FOUND", 404, "Subscriber not found.");
    // Inactive subscribers may get a service (e.g. set up before reactivation); closed ones may not.
    if (subscriber.status === "terminated" || subscriber.status === "archived") {
      throw new ServiceAccountError(
        "SUBSCRIBER_CLOSED",
        409,
        `A ${subscriber.status} subscriber cannot get a new service account.`,
      );
    }

    const plan = await activePlan(tx, input.planId);
    await assertAddress(tx, subscriberId, input.installationAddressId);
    if (input.assignedCollectorId) await assertCollector(tx, input.assignedCollectorId);

    const values = {
      planId: input.planId,
      installationAddressId: input.installationAddressId,
      billingDay: input.billingDay ?? subscriber.billingDay,
      // Rate snapshot: later plan price changes do not touch this account.
      currentRateCentavos: plan.priceCentavos,
      assignedCollectorId: input.assignedCollectorId ?? null,
      notes: input.notes ?? null,
    };
    const [created] = await tx
      .insert(serviceAccounts)
      .values({ subscriberId, ...values })
      .returning({ id: serviceAccounts.id });
    if (!created) throw new Error("Failed to create service account");

    await recordChange(tx, "service_account.create", {
      serviceAccountId: created.id,
      actorUserId,
      eventType: "created",
      toStatus: "pending",
      newValues: { subscriberId, status: "pending", ...values },
    });

    return fetchServiceAccount(tx, created.id);
  });
}

/* ------------------------------- Update ------------------------------- */

export async function updateServiceAccount(
  db: Db,
  actorUserId: string,
  id: string,
  input: ServiceAccountUpdateInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const existing = await lockAccount(tx, id);
    assertNotTerminated(existing);

    const { reason, ...fields } = input;
    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchServiceAccount(tx, id);

    if (fields.installationAddressId && newValues.installationAddressId) {
      await assertAddress(tx, existing.subscriberId, fields.installationAddressId);
    }

    await tx
      .update(serviceAccounts)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(serviceAccounts.id, id));

    await recordChange(tx, "service_account.update", {
      serviceAccountId: id,
      actorUserId,
      eventType: "update",
      oldValues,
      newValues,
      reason: reason ?? null,
    });

    return fetchServiceAccount(tx, id);
  });
}

/* ---------------------------- Status change ---------------------------- */

export async function changeServiceStatus(
  db: Db,
  actorUserId: string,
  id: string,
  input: ServiceStatusChangeInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const existing = await lockAccount(tx, id);

    const problem = serviceStatusChangeProblem(existing.status as ServiceAccountStatus, input.status);
    if (problem) throw new ServiceAccountError("INVALID_STATUS_CHANGE", 409, problem);

    // A closed subscriber's services can only be terminated.
    if (input.status !== "terminated") {
      const [subscriber] = await tx
        .select({ status: subscribers.status })
        .from(subscribers)
        .where(eq(subscribers.id, existing.subscriberId))
        .limit(1);
      if (subscriber && (subscriber.status === "terminated" || subscriber.status === "archived")) {
        throw new ServiceAccountError(
          "SUBSCRIBER_CLOSED",
          409,
          `The subscriber is ${subscriber.status}; this service can only be terminated.`,
        );
      }
    }

    const effectiveDate = input.effectiveDate ?? (await dbToday(tx));
    const firstActivation = existing.status === "pending" && input.status === "active";

    if (input.billingStartDate !== undefined && !firstActivation) {
      throw new ServiceAccountError(
        "INVALID_DATE",
        422,
        "A billing start date can only be set when the service is first activated.",
      );
    }
    const billingStartDate = firstActivation ? (input.billingStartDate ?? effectiveDate) : undefined;
    if (billingStartDate !== undefined && billingStartDate < effectiveDate) {
      throw new ServiceAccountError("INVALID_DATE", 422, "Billing cannot start before the activation date.");
    }

    const dates = firstActivation ? { activationDate: effectiveDate, billingStartDate } : {};
    await tx
      .update(serviceAccounts)
      .set({ status: input.status, ...dates, updatedAt: new Date() })
      .where(eq(serviceAccounts.id, id));

    await recordChange(tx, "service_account.status_change", {
      serviceAccountId: id,
      actorUserId,
      eventType: "status_change",
      fromStatus: existing.status,
      toStatus: input.status,
      oldValues: { status: existing.status },
      newValues: { status: input.status, ...dates },
      effectiveDate,
      reason: input.reason,
    });

    return fetchServiceAccount(tx, id);
  });
}

/* ----------------------------- Rate change ----------------------------- */

export async function changeServiceRate(
  db: Db,
  actorUserId: string,
  id: string,
  input: ServiceRateChangeInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const existing = await lockAccount(tx, id);
    assertNotTerminated(existing);
    if (existing.currentRateCentavos === input.rateCentavos) return fetchServiceAccount(tx, id);

    await tx
      .update(serviceAccounts)
      .set({ currentRateCentavos: input.rateCentavos, updatedAt: new Date() })
      .where(eq(serviceAccounts.id, id));

    await recordChange(tx, "service_account.rate_change", {
      serviceAccountId: id,
      actorUserId,
      eventType: "rate_change",
      oldValues: { rateCentavos: existing.currentRateCentavos },
      newValues: { rateCentavos: input.rateCentavos },
      effectiveDate: input.effectiveDate ?? (await dbToday(tx)),
      reason: input.reason,
    });

    return fetchServiceAccount(tx, id);
  });
}

/* ----------------------------- Plan change ----------------------------- */

export async function changeServicePlan(
  db: Db,
  actorUserId: string,
  id: string,
  input: ServicePlanChangeInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const existing = await lockAccount(tx, id);
    assertNotTerminated(existing);
    if (existing.planId === input.planId) {
      throw new ServiceAccountError(
        "SAME_PLAN",
        409,
        "The service is already on this plan. Use a rate change to adjust its rate.",
      );
    }

    const plan = await activePlan(tx, input.planId);
    const rateCentavos = input.rateCentavos ?? plan.priceCentavos;

    await tx
      .update(serviceAccounts)
      .set({ planId: input.planId, currentRateCentavos: rateCentavos, updatedAt: new Date() })
      .where(eq(serviceAccounts.id, id));

    await recordChange(tx, "service_account.plan_change", {
      serviceAccountId: id,
      actorUserId,
      eventType: "plan_change",
      oldValues: { planId: existing.planId, rateCentavos: existing.currentRateCentavos },
      newValues: { planId: input.planId, rateCentavos },
      effectiveDate: input.effectiveDate ?? (await dbToday(tx)),
      reason: input.reason,
    });

    return fetchServiceAccount(tx, id);
  });
}

/* --------------------------- Collector change --------------------------- */

export async function changeServiceCollector(
  db: Db,
  actorUserId: string,
  id: string,
  input: ServiceCollectorChangeInput,
): Promise<ServiceAccountDetail> {
  return db.transaction(async (tx) => {
    const existing = await lockAccount(tx, id);
    assertNotTerminated(existing);
    if (existing.assignedCollectorId === input.assignedCollectorId) return fetchServiceAccount(tx, id);
    if (input.assignedCollectorId) await assertCollector(tx, input.assignedCollectorId);

    await tx
      .update(serviceAccounts)
      .set({ assignedCollectorId: input.assignedCollectorId, updatedAt: new Date() })
      .where(eq(serviceAccounts.id, id));

    await recordChange(tx, "service_account.collector_change", {
      serviceAccountId: id,
      actorUserId,
      eventType: "collector_change",
      oldValues: { assignedCollectorId: existing.assignedCollectorId },
      newValues: { assignedCollectorId: input.assignedCollectorId },
      reason: input.reason ?? null,
    });

    return fetchServiceAccount(tx, id);
  });
}
