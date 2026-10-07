import { and, asc, count, eq, ilike, ne, or } from "drizzle-orm";
import type { SubscriberListQuery } from "@bcis/shared";
import type { Db } from "../db/client";
import {
  collectionAreas,
  collectors,
  subscriberAddresses,
  subscriberContacts,
  subscribers,
} from "../db/schema";

export class SubscriberError extends Error {
  constructor(
    public readonly code: "NOT_FOUND",
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