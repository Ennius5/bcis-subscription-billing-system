import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import {
  contactValueProblem,
  statusChangeProblem,
  SUBSCRIBER_CONTACTS_MAX,
  type AddressCreateInput,
  type AddressUpdateInput,
  type ContactInput,
  type ContactType,
  type ContactUpdateInput,
  type SubscriberAssignmentInput,
  type SubscriberUpdateInput,
  type SubscriberCreateInput,
  type SubscriberListQuery,
  type SubscriberStatus,
  type SubscriberStatusChangeInput,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { changedFields, likePattern, type Tx } from "../db/query_helpers";
import {
  auditLogs,
  collectionAreas,
  collectorAssignments,
  collectors,
  serviceAccounts,
  subscriberAddresses,
  subscriberContacts,
  subscribers,
  users,
} from "../db/schema";

export class SubscriberError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "AREA_NOT_FOUND"
      | "AREA_INACTIVE"
      | "COLLECTOR_NOT_FOUND"
      | "COLLECTOR_INACTIVE"
      | "INVALID_STATUS_CHANGE"
      | "SUBSCRIBER_ARCHIVED"
      | "ADDRESS_NOT_FOUND"
      | "CONTACT_NOT_FOUND"
      | "PRIMARY_CANNOT_DEACTIVATE"
      | "INACTIVE_CANNOT_BE_PRIMARY"
      | "CONTACT_LIMIT"
      | "INVALID_CONTACT_VALUE"
      | "ADDRESS_IN_USE",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------- List ------------------------------- */

export type SubscriberListRow = {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  billingDay: number;
  collectionAreaId: string | null;
  areaCode: string | null;
  areaName: string | null;
  assignedCollectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  primaryContact: string | null;
  primaryAddress: string | null;
};

export type SubscriberListPage = {
  items: SubscriberListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listSubscribers(
  db: Db,
  query: SubscriberListQuery,
): Promise<SubscriberListPage> {
  const where = and(
    // Archived subscribers only appear when the Archived filter is chosen.
    query.status ? eq(subscribers.status, query.status) : ne(subscribers.status, "archived"),
    query.collectionAreaId ? eq(subscribers.collectionAreaId, query.collectionAreaId) : undefined,
    query.assignedCollectorId
      ? eq(subscribers.assignedCollectorId, query.assignedCollectorId)
      : undefined,
    query.search
      ? or(
          ilike(subscribers.fullName, likePattern(query.search)),
          ilike(subscribers.accountNumber, likePattern(query.search)),
        )
      : undefined,
  );

  // The partial unique indexes guarantee at most one primary address and one
  // primary contact per subscriber, so these joins never duplicate a row.
  const itemsQuery = db
    .select({
      id: subscribers.id,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      status: subscribers.status,
      billingDay: subscribers.billingDay,
      collectionAreaId: subscribers.collectionAreaId,
      areaCode: collectionAreas.code,
      areaName: collectionAreas.name,
      assignedCollectorId: subscribers.assignedCollectorId,
      collectorCode: collectors.code,
      collectorName: collectors.fullName,
      primaryContact: subscriberContacts.value,
      primaryAddress: subscriberAddresses.line1,
    })
    .from(subscribers)
    .leftJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .leftJoin(collectors, eq(subscribers.assignedCollectorId, collectors.id))
    .leftJoin(
      subscriberAddresses,
      and(
        eq(subscriberAddresses.subscriberId, subscribers.id),
        eq(subscriberAddresses.isPrimary, true),
      ),
    )
    .leftJoin(
      subscriberContacts,
      and(
        eq(subscriberContacts.subscriberId, subscribers.id),
        eq(subscriberContacts.isPrimary, true),
      ),
    )
    .where(where)
    .orderBy(asc(subscribers.accountNumber))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  // Every filter is on the subscribers table, so the count needs no joins.
  const totalQuery = db.select({ value: count() }).from(subscribers).where(where);

  const [items, [totalRow]] = await Promise.all([itemsQuery, totalQuery]);

  return {
    items,
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/* ------------------------------ Detail ------------------------------ */

export type SubscriberAddressRow = {
  id: string;
  label: string | null;
  line1: string;
  barangay: string;
  city: string;
  province: string | null;
  landmark: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

export type SubscriberContactRow = {
  id: string;
  type: string;
  value: string;
  contactName: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

export type SubscriberDetail = {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  billingDay: number;
  notes: string | null;
  collectionAreaId: string | null;
  areaCode: string | null;
  areaName: string | null;
  assignedCollectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  createdAt: Date;
  updatedAt: Date;
  addresses: SubscriberAddressRow[];
  contacts: SubscriberContactRow[];
};

/** Works with the plain database or inside a transaction. */
async function fetchSubscriber(executor: DbOrTx, id: string): Promise<SubscriberDetail> {
  const [row] = await executor
    .select({
      id: subscribers.id,
      accountNumber: subscribers.accountNumber,
      fullName: subscribers.fullName,
      status: subscribers.status,
      billingDay: subscribers.billingDay,
      notes: subscribers.notes,
      collectionAreaId: subscribers.collectionAreaId,
      areaCode: collectionAreas.code,
      areaName: collectionAreas.name,
      assignedCollectorId: subscribers.assignedCollectorId,
      collectorCode: collectors.code,
      collectorName: collectors.fullName,
      createdAt: subscribers.createdAt,
      updatedAt: subscribers.updatedAt,
    })
    .from(subscribers)
    .leftJoin(collectionAreas, eq(subscribers.collectionAreaId, collectionAreas.id))
    .leftJoin(collectors, eq(subscribers.assignedCollectorId, collectors.id))
    .where(eq(subscribers.id, id))
    .limit(1);
  if (!row) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");

  // The primary address and contact are listed first.
  const addresses = await executor
    .select({
      id: subscriberAddresses.id,
      label: subscriberAddresses.label,
      line1: subscriberAddresses.line1,
      barangay: subscriberAddresses.barangay,
      city: subscriberAddresses.city,
      province: subscriberAddresses.province,
      landmark: subscriberAddresses.landmark,
      isPrimary: subscriberAddresses.isPrimary,
      isActive: subscriberAddresses.isActive,
    })
    .from(subscriberAddresses)
    .where(eq(subscriberAddresses.subscriberId, id))
    .orderBy(desc(subscriberAddresses.isPrimary), asc(subscriberAddresses.createdAt));

  const contacts = await executor
    .select({
      id: subscriberContacts.id,
      type: subscriberContacts.type,
      value: subscriberContacts.value,
      contactName: subscriberContacts.contactName,
      isPrimary: subscriberContacts.isPrimary,
      isActive: subscriberContacts.isActive,
    })
    .from(subscriberContacts)
    .where(eq(subscriberContacts.subscriberId, id))
    .orderBy(desc(subscriberContacts.isPrimary), asc(subscriberContacts.createdAt));

  return { ...row, addresses, contacts };
}

export async function getSubscriber(db: Db, id: string): Promise<SubscriberDetail> {
  return fetchSubscriber(db, id);
}

/* ------------------------------ History ------------------------------ */

export type SubscriberHistoryRow = {
  id: string;
  occurredAt: Date;
  action: string;
  actorUsername: string | null;
  actorName: string | null;
  reason: string | null;
  oldValues: unknown;
  newValues: unknown;
};

/** The subscriber's audit trail, newest first. Address and contact changes are included. */
export async function listSubscriberHistory(db: Db, id: string): Promise<SubscriberHistoryRow[]> {
  const [exists] = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.id, id))
    .limit(1);
  if (!exists) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");

  return db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      action: auditLogs.action,
      actorUsername: users.username,
      actorName: users.fullName,
      reason: auditLogs.reason,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .where(and(eq(auditLogs.entityType, "subscriber"), eq(auditLogs.entityId, id)))
    .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id));
}

/* ------------------------------ Create ------------------------------ */

/** An assignment may only point at areas and collectors that exist and are active. */
async function assertAssignmentTargets(
  tx: Tx,
  areaId: string | null | undefined,
  collectorId: string | null | undefined,
): Promise<void> {
  if (areaId) {
    const [area] = await tx
      .select({ code: collectionAreas.code, isActive: collectionAreas.isActive })
      .from(collectionAreas)
      .where(eq(collectionAreas.id, areaId))
      .limit(1);
    if (!area) {
      throw new SubscriberError("AREA_NOT_FOUND", 422, "The selected collection area does not exist.");
    }
    if (!area.isActive) {
      throw new SubscriberError("AREA_INACTIVE", 422, `Collection area ${area.code} is inactive.`);
    }
  }
  if (collectorId) {
    const [collector] = await tx
      .select({ code: collectors.code, isActive: collectors.isActive })
      .from(collectors)
      .where(eq(collectors.id, collectorId))
      .limit(1);
    if (!collector) {
      throw new SubscriberError("COLLECTOR_NOT_FOUND", 422, "The selected collector does not exist.");
    }
    if (!collector.isActive) {
      throw new SubscriberError("COLLECTOR_INACTIVE", 422, `Collector ${collector.code} is inactive.`);
    }
  }
}

export async function createSubscriber(
  db: Db,
  actorUserId: string,
  input: SubscriberCreateInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    await assertAssignmentTargets(tx, input.collectionAreaId, input.assignedCollectorId);

    const [created] = await tx
      .insert(subscribers)
      .values({
        fullName: input.fullName,
        billingDay: input.billingDay,
        collectionAreaId: input.collectionAreaId ?? null,
        assignedCollectorId: input.assignedCollectorId ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: subscribers.id });
    if (!created) throw new Error("Failed to create subscriber");

    // The address typed on the form becomes the primary address.
    await tx.insert(subscriberAddresses).values({
      subscriberId: created.id,
      label: input.address.label ?? null,
      line1: input.address.line1,
      barangay: input.address.barangay,
      city: input.address.city,
      province: input.address.province ?? null,
      landmark: input.address.landmark ?? null,
      isPrimary: true,
    });

    if (input.contacts.length > 0) {
      await tx.insert(subscriberContacts).values(
        input.contacts.map((contact) => ({
          subscriberId: created.id,
          type: contact.type,
          value: contact.value,
          contactName: contact.contactName ?? null,
          isPrimary: contact.isPrimary ?? false,
        })),
      );
    }

    // First assignment: history row only when there is something to record.
    if (input.collectionAreaId || input.assignedCollectorId) {
      await tx.insert(collectorAssignments).values({
        subscriberId: created.id,
        collectionAreaId: input.collectionAreaId ?? null,
        collectorId: input.assignedCollectorId ?? null,
        assignedByUserId: actorUserId,
        reason: "Initial assignment",
      });
    }

    const subscriber = await fetchSubscriber(tx, created.id);
    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.create",
      entityType: "subscriber",
      entityId: subscriber.id,
      newValues: subscriber,
    });
    return subscriber;
  });
}

/* --------------------------- Status change --------------------------- */

export async function changeSubscriberStatus(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: SubscriberStatusChangeInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ status: subscribers.status })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for("update");
    if (!existing) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");

    const problem = statusChangeProblem(existing.status as SubscriberStatus, input.status);
    if (problem) throw new SubscriberError("INVALID_STATUS_CHANGE", 409, problem);

    // Phase 4: decide whether "terminated" must be blocked while a balance is outstanding.

    await tx
      .update(subscribers)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(subscribers.id, subscriberId));

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.status_change",
      entityType: "subscriber",
      entityId: subscriberId,
      reason: input.reason,
      oldValues: { status: existing.status },
      newValues: { status: input.status },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

/* ------------------------------ Update ------------------------------ */

export async function updateSubscriber(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: SubscriberUpdateInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for("update");
    if (!existing) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");

    // Archived is final, so the record is read-only.
    if (existing.status === "archived") {
      throw new SubscriberError(
        "SUBSCRIBER_ARCHIVED",
        409,
        "An archived subscriber can no longer be edited.",
      );
    }

    const { reason, ...fields } = input;
    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchSubscriber(tx, subscriberId);

    await tx
      .update(subscribers)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(subscribers.id, subscriberId));

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.update",
      entityType: "subscriber",
      entityId: subscriberId,
      reason: reason ?? null,
      oldValues,
      newValues,
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

/* ------------------------- Assignment change ------------------------- */

export async function changeSubscriberAssignment(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: SubscriberAssignmentInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        status: subscribers.status,
        collectionAreaId: subscribers.collectionAreaId,
        assignedCollectorId: subscribers.assignedCollectorId,
      })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId))
      .for("update");
    if (!existing) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");

    if (existing.status === "archived") {
      throw new SubscriberError(
        "SUBSCRIBER_ARCHIVED",
        409,
        "An archived subscriber can no longer be reassigned.",
      );
    }

    if (
      existing.collectionAreaId === input.collectionAreaId &&
      existing.assignedCollectorId === input.assignedCollectorId
    ) {
      return fetchSubscriber(tx, subscriberId);
    }

    await assertAssignmentTargets(tx, input.collectionAreaId, input.assignedCollectorId);

    // Database now() is the transaction start time, so the closed period and
    // the new one meet exactly, using the same clock as effective_from defaults.
    await tx
      .update(collectorAssignments)
      .set({ effectiveTo: sql`now()` })
      .where(
        and(
          eq(collectorAssignments.subscriberId, subscriberId),
          isNull(collectorAssignments.effectiveTo),
        ),
      );

    // Clearing both fields only closes the open period; no open row means unassigned.
    if (input.collectionAreaId || input.assignedCollectorId) {
      await tx.insert(collectorAssignments).values({
        subscriberId,
        collectionAreaId: input.collectionAreaId,
        collectorId: input.assignedCollectorId,
        effectiveFrom: sql`now()`,
        assignedByUserId: actorUserId,
        reason: input.reason ?? null,
      });
    }

    await tx
      .update(subscribers)
      .set({
        collectionAreaId: input.collectionAreaId,
        assignedCollectorId: input.assignedCollectorId,
        updatedAt: new Date(),
      })
      .where(eq(subscribers.id, subscriberId));

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.assignment_change",
      entityType: "subscriber",
      entityId: subscriberId,
      reason: input.reason ?? null,
      oldValues: {
        collectionAreaId: existing.collectionAreaId,
        assignedCollectorId: existing.assignedCollectorId,
      },
      newValues: {
        collectionAreaId: input.collectionAreaId,
        assignedCollectorId: input.assignedCollectorId,
      },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

/* ----------------------- Addresses and contacts ----------------------- */

// Address and contact changes are audited against the subscriber so they show
// in the subscriber's history; the address or contact id is in the values.

/** Locks the subscriber so changes to its addresses and contacts run one at a time. */
async function lockEditableSubscriber(tx: Tx, subscriberId: string): Promise<void> {
  const [row] = await tx
    .select({ status: subscribers.status })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .for("update");
  if (!row) throw new SubscriberError("NOT_FOUND", 404, "Subscriber not found.");
  if (row.status === "archived") {
    throw new SubscriberError(
      "SUBSCRIBER_ARCHIVED",
      409,
      "An archived subscriber can no longer be edited.",
    );
  }
}

/** The primary must stay active: promote another one before deactivating it. */
function primaryProblem(
  kind: "address" | "contact",
  wasPrimary: boolean,
  willBeActive: boolean,
  willBePrimary: boolean,
): SubscriberError | null {
  if (!willBePrimary || willBeActive) return null;
  return wasPrimary
    ? new SubscriberError(
        "PRIMARY_CANNOT_DEACTIVATE",
        409,
        `The primary ${kind} cannot be deactivated. Make another ${kind} primary first.`,
      )
    : new SubscriberError(
        "INACTIVE_CANNOT_BE_PRIMARY",
        409,
        `An inactive ${kind} cannot be made primary.`,
      );
}

/** Clears the current primary first, because the partial unique index allows only one. */
async function demotePrimaryAddress(tx: Tx, subscriberId: string): Promise<string | null> {
  const [demoted] = await tx
    .update(subscriberAddresses)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(subscriberAddresses.subscriberId, subscriberId), eq(subscriberAddresses.isPrimary, true)),
    )
    .returning({ id: subscriberAddresses.id });
  return demoted?.id ?? null;
}

async function demotePrimaryContact(tx: Tx, subscriberId: string): Promise<string | null> {
  const [demoted] = await tx
    .update(subscriberContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(subscriberContacts.subscriberId, subscriberId), eq(subscriberContacts.isPrimary, true)),
    )
    .returning({ id: subscriberContacts.id });
  return demoted?.id ?? null;
}

async function assertContactRoom(tx: Tx, subscriberId: string): Promise<void> {
  const [row] = await tx
    .select({ value: count() })
    .from(subscriberContacts)
    .where(and(eq(subscriberContacts.subscriberId, subscriberId), eq(subscriberContacts.isActive, true)));
  if ((row?.value ?? 0) >= SUBSCRIBER_CONTACTS_MAX) {
    throw new SubscriberError(
      "CONTACT_LIMIT",
      409,
      `A subscriber can have at most ${SUBSCRIBER_CONTACTS_MAX} active contacts.`,
    );
  }
}

export async function addSubscriberAddress(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: AddressCreateInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    await lockEditableSubscriber(tx, subscriberId);

    const isPrimary = input.isPrimary ?? false;
    const demotedAddressId = isPrimary ? await demotePrimaryAddress(tx, subscriberId) : null;

    const values = {
      label: input.label ?? null,
      line1: input.line1,
      barangay: input.barangay,
      city: input.city,
      province: input.province ?? null,
      landmark: input.landmark ?? null,
      isPrimary,
    };
    const [created] = await tx
      .insert(subscriberAddresses)
      .values({ subscriberId, ...values })
      .returning({ id: subscriberAddresses.id });
    if (!created) throw new Error("Failed to add address");

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.address_add",
      entityType: "subscriber",
      entityId: subscriberId,
      newValues: { addressId: created.id, ...values, ...(demotedAddressId && { demotedAddressId }) },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

export async function updateSubscriberAddress(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  addressId: string,
  input: AddressUpdateInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    await lockEditableSubscriber(tx, subscriberId);

    const [existing] = await tx
      .select()
      .from(subscriberAddresses)
      .where(and(eq(subscriberAddresses.id, addressId), eq(subscriberAddresses.subscriberId, subscriberId)))
      .limit(1);
    if (!existing) throw new SubscriberError("ADDRESS_NOT_FOUND", 404, "Address not found.");

    const { reason, ...fields } = input;
    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchSubscriber(tx, subscriberId);

    const problem = primaryProblem(
      "address",
      existing.isPrimary,
      fields.isActive ?? existing.isActive,
      fields.isPrimary ?? existing.isPrimary,
    );
    if (problem) throw problem;

    // A live service is installed here; it must be moved or terminated first.
    if (newValues.isActive === false) {
      const [inUse] = await tx
        .select({ serviceNumber: serviceAccounts.serviceNumber })
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.installationAddressId, addressId), ne(serviceAccounts.status, "terminated")))
        .limit(1);
      if (inUse) {
        throw new SubscriberError(
          "ADDRESS_IN_USE",
          409,
          `Service account ${inUse.serviceNumber} is installed at this address. Move or terminate it first.`,
        );
      }
    }

    if (newValues.isPrimary) {
      const demotedAddressId = await demotePrimaryAddress(tx, subscriberId);
      if (demotedAddressId) newValues.demotedAddressId = demotedAddressId;
    }

    await tx
      .update(subscriberAddresses)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(subscriberAddresses.id, addressId));

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.address_update",
      entityType: "subscriber",
      entityId: subscriberId,
      reason: reason ?? null,
      oldValues: { addressId, ...oldValues },
      newValues: { addressId, ...newValues },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

export async function addSubscriberContact(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  input: ContactInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    await lockEditableSubscriber(tx, subscriberId);
    await assertContactRoom(tx, subscriberId);

    const isPrimary = input.isPrimary ?? false;
    const demotedContactId = isPrimary ? await demotePrimaryContact(tx, subscriberId) : null;

    const values = {
      type: input.type,
      value: input.value,
      contactName: input.contactName ?? null,
      isPrimary,
    };
    const [created] = await tx
      .insert(subscriberContacts)
      .values({ subscriberId, ...values })
      .returning({ id: subscriberContacts.id });
    if (!created) throw new Error("Failed to add contact");

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.contact_add",
      entityType: "subscriber",
      entityId: subscriberId,
      newValues: { contactId: created.id, ...values, ...(demotedContactId && { demotedContactId }) },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}

export async function updateSubscriberContact(
  db: Db,
  actorUserId: string,
  subscriberId: string,
  contactId: string,
  input: ContactUpdateInput,
): Promise<SubscriberDetail> {
  return db.transaction(async (tx) => {
    await lockEditableSubscriber(tx, subscriberId);

    const [existing] = await tx
      .select()
      .from(subscriberContacts)
      .where(and(eq(subscriberContacts.id, contactId), eq(subscriberContacts.subscriberId, subscriberId)))
      .limit(1);
    if (!existing) throw new SubscriberError("CONTACT_NOT_FOUND", 404, "Contact not found.");

    const { reason, ...fields } = input;

    // The type is fixed at creation, so a new value is checked against the stored type.
    if (fields.value !== undefined) {
      const problem = contactValueProblem(existing.type as ContactType, fields.value);
      if (problem) throw new SubscriberError("INVALID_CONTACT_VALUE", 422, problem);
    }

    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchSubscriber(tx, subscriberId);

    const problem = primaryProblem(
      "contact",
      existing.isPrimary,
      fields.isActive ?? existing.isActive,
      fields.isPrimary ?? existing.isPrimary,
    );
    if (problem) throw problem;

    // Reactivating takes one of the active contact slots.
    if (newValues.isActive === true) await assertContactRoom(tx, subscriberId);

    if (newValues.isPrimary) {
      const demotedContactId = await demotePrimaryContact(tx, subscriberId);
      if (demotedContactId) newValues.demotedContactId = demotedContactId;
    }

    await tx
      .update(subscriberContacts)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(subscriberContacts.id, contactId));

    await writeAudit(tx, {
      actorUserId,
      action: "subscriber.contact_update",
      entityType: "subscriber",
      entityId: subscriberId,
      reason: reason ?? null,
      oldValues: { contactId, ...oldValues },
      newValues: { contactId, ...newValues },
    });

    return fetchSubscriber(tx, subscriberId);
  });
}