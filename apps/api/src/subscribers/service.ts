import { and, asc, count, desc, eq, ilike, ne, or } from "drizzle-orm";
import type { SubscriberCreateInput, SubscriberListQuery } from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import type { Tx } from "../db/query_helpers";
import {
  collectionAreas,
  collectorAssignments,
  collectors,
  subscriberAddresses,
  subscriberContacts,
  subscribers,
} from "../db/schema";

export class SubscriberError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "AREA_NOT_FOUND"
      | "AREA_INACTIVE"
      | "COLLECTOR_NOT_FOUND"
      | "COLLECTOR_INACTIVE",
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

/** Contains-match pattern for ILIKE, with %, _ and \ escaped so they match literally. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

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