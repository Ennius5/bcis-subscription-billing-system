import { sql } from "drizzle-orm";
import type { DbOrTx } from "../audit/audit";

/** The newest batches shown on the profile; a subscriber is on roughly one batch a month. */
const LIMIT = 60;

export interface SubscriberBatchCollection {
  receiptNumber: string;
  paymentId: string;
  method: string;
  amountCentavos: number;
  paymentDate: string;
  status: string;
}

export interface SubscriberBatchRow {
  batchId: string;
  batchNumber: string;
  collectionDate: string;
  status: string;
  collectorName: string;
  /** What the route sheet said was due, frozen when the subscriber was put on the batch. */
  currentCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  /** Posted (not reversed) field collections for this subscriber on this batch. */
  collectedCentavos: number;
  collections: SubscriberBatchCollection[];
}

/**
 * The profile's Collection tab: every collection batch this subscriber was on, newest first,
 * with the due amounts from the route sheet and what the collector actually collected.
 */
export async function listSubscriberCollections(db: DbOrTx, subscriberId: string): Promise<SubscriberBatchRow[]> {
  const result = await db.execute<{
    batch_id: string;
    batch_number: string;
    collection_date: string;
    status: string;
    collector_name: string;
    current_centavos: number;
    arrears_centavos: number;
    total_due_centavos: number;
    collections: SubscriberBatchCollection[] | null;
  }>(sql`
    SELECT b.id AS batch_id, b.batch_number, b.collection_date::text AS collection_date, b.status,
           c.full_name AS collector_name,
           ba.current_centavos, ba.arrears_centavos, ba.total_due_centavos,
           (SELECT json_agg(json_build_object(
                     'paymentId', p.id, 'receiptNumber', p.receipt_number, 'method', p.method,
                     'amountCentavos', p.amount_centavos, 'paymentDate', p.payment_date::text, 'status', p.status)
                   ORDER BY p.posted_at)
              FROM payments p
             WHERE p.collection_batch_id = b.id AND p.subscriber_id = ba.subscriber_id) AS collections
      FROM batch_accounts ba
      JOIN collection_batches b ON b.id = ba.batch_id
      JOIN collectors c ON c.id = b.collector_id
     WHERE ba.subscriber_id = ${subscriberId}
     ORDER BY b.collection_date DESC, b.batch_number DESC
     LIMIT ${LIMIT}
  `);

  return result.rows.map((r) => {
    const collections = r.collections ?? [];
    return {
      batchId: r.batch_id,
      batchNumber: r.batch_number,
      collectionDate: r.collection_date,
      status: r.status,
      collectorName: r.collector_name,
      currentCentavos: r.current_centavos,
      arrearsCentavos: r.arrears_centavos,
      totalDueCentavos: r.total_due_centavos,
      collectedCentavos: collections.filter((c) => c.status === "posted").reduce((sum, c) => sum + c.amountCentavos, 0),
      collections,
    };
  });
}
