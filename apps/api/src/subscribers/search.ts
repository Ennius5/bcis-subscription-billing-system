import { sql } from "drizzle-orm";
import {
  GLOBAL_SEARCH_LIMIT,
  normalizeGcashReference,
  phoneSearchDigits,
  type GlobalSearchField,
  type GlobalSearchQuery,
} from "@bcis/shared";
import type { Db } from "../db/client";
import { likePattern } from "../db/query_helpers";

export interface GlobalSearchMatch {
  field: GlobalSearchField;
  value: string;
}

export interface GlobalSearchHit {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  primaryAddress: string | null;
  primaryContact: string | null;
  /** What the query matched, so the result can say why it is listed. */
  matches: GlobalSearchMatch[];
}

export interface GlobalSearchResult {
  query: string;
  items: GlobalSearchHit[];
  /** True when more subscribers matched than are returned; the user should search more precisely. */
  hasMore: boolean;
}

interface Row extends Record<string, unknown> {
  id: string;
  account_number: string;
  full_name: string;
  status: string;
  primary_address: string | null;
  primary_contact: string | null;
  account_match: boolean;
  name_match: boolean;
  service_match: string | null;
  contact_match: string | null;
  address_match: string | null;
  receipt_match: string | null;
  invoice_match: string | null;
  gcash_match: string | null;
}

// These two expressions must stay identical to the trigram indexes in migration 0011,
// otherwise PostgreSQL cannot use the indexes. They are SQL literals, never parameters.
const CONTACT_DIGITS = sql.raw(`regexp_replace(c.value, '\\D', '', 'g')`);
const ADDRESS_TEXT = sql.raw(
  `(a.line1 || ' ' || a.barangay || ' ' || a.city || ' ' || coalesce(a.province, '') || ' ' || coalesce(a.landmark, ''))`,
);

/**
 * Global search (spec 3.2): account number, service number, name, contact number, address,
 * receipt number, invoice number and GCash reference. Every hit is the subscriber the record
 * belongs to. All statuses are searched, archived included: finding any account is the point.
 */
export async function globalSearch(db: Db, query: GlobalSearchQuery): Promise<GlobalSearchResult> {
  const q = query.q;
  const pattern = likePattern(q);
  const digits = phoneSearchDigits(q);
  // Digits only, so nothing needs escaping in this pattern.
  const digitMatch = digits ? sql` OR ${CONTACT_DIGITS} LIKE ${`%${digits}%`}` : sql``;
  const contactCondition = sql`(c.value ILIKE ${pattern}${digitMatch})`;
  const addressCondition = sql`${ADDRESS_TEXT} ILIKE ${pattern}`;
  // GCash references are stored normalized (no spaces, upper case), so the query is too.
  const gcashPattern = likePattern(normalizeGcashReference(q));

  const result = await db.execute<Row>(sql`
    WITH hits AS (
      SELECT s.id AS subscriber_id FROM subscribers s
        WHERE s.account_number ILIKE ${pattern} OR s.full_name ILIKE ${pattern}
      UNION
      SELECT sa.subscriber_id FROM service_accounts sa WHERE sa.service_number ILIKE ${pattern}
      UNION
      SELECT c.subscriber_id FROM subscriber_contacts c WHERE ${contactCondition}
      UNION
      SELECT a.subscriber_id FROM subscriber_addresses a WHERE ${addressCondition}
      UNION
      SELECT p.subscriber_id FROM payments p WHERE p.receipt_number ILIKE ${pattern}
      UNION
      SELECT i.subscriber_id FROM invoices i WHERE i.invoice_number ILIKE ${pattern}
      UNION
      SELECT g.subscriber_id FROM gcash_submissions g WHERE g.reference_number ILIKE ${gcashPattern}
    ),
    found AS (
      SELECT
        s.id,
        s.account_number,
        s.full_name,
        s.status,
        (SELECT a.line1 || ', ' || a.barangay || ', ' || a.city
           FROM subscriber_addresses a WHERE a.subscriber_id = s.id AND a.is_primary) AS primary_address,
        (SELECT c.value FROM subscriber_contacts c
           WHERE c.subscriber_id = s.id AND c.is_primary) AS primary_contact,
        s.account_number ILIKE ${pattern} AS account_match,
        s.full_name ILIKE ${pattern} AS name_match,
        (SELECT sa.service_number FROM service_accounts sa
           WHERE sa.subscriber_id = s.id AND sa.service_number ILIKE ${pattern}
           ORDER BY sa.service_number LIMIT 1) AS service_match,
        (SELECT c.value FROM subscriber_contacts c
           WHERE c.subscriber_id = s.id AND ${contactCondition}
           ORDER BY c.is_primary DESC, c.is_active DESC LIMIT 1) AS contact_match,
        (SELECT a.line1 || ', ' || a.barangay || ', ' || a.city FROM subscriber_addresses a
           WHERE a.subscriber_id = s.id AND ${addressCondition}
           ORDER BY a.is_primary DESC, a.is_active DESC LIMIT 1) AS address_match,
        (SELECT p.receipt_number FROM payments p
           WHERE p.subscriber_id = s.id AND p.receipt_number ILIKE ${pattern}
           ORDER BY p.receipt_number DESC LIMIT 1) AS receipt_match,
        (SELECT i.invoice_number FROM invoices i
           WHERE i.subscriber_id = s.id AND i.invoice_number ILIKE ${pattern}
           ORDER BY i.invoice_number DESC LIMIT 1) AS invoice_match,
        (SELECT g.reference_number FROM gcash_submissions g
           WHERE g.subscriber_id = s.id AND g.reference_number ILIKE ${gcashPattern}
           ORDER BY g.recorded_at DESC LIMIT 1) AS gcash_match
      FROM subscribers s
      JOIN hits h ON h.subscriber_id = s.id
    )
    SELECT * FROM found
    ORDER BY
      -- An exact number or reference first, then names that start with the query.
      CASE
        WHEN lower(account_number) = lower(${q}) OR lower(service_match) = lower(${q})
          OR lower(receipt_match) = lower(${q}) OR lower(invoice_match) = lower(${q})
          OR gcash_match = ${normalizeGcashReference(q)} THEN 0
        WHEN full_name ILIKE ${pattern.slice(1)} THEN 1 -- "text%": starts with the query
        ELSE 2
      END,
      full_name,
      account_number
    LIMIT ${GLOBAL_SEARCH_LIMIT + 1}
  `);

  const rows = result.rows;
  return {
    query: q,
    items: rows.slice(0, GLOBAL_SEARCH_LIMIT).map(toHit),
    hasMore: rows.length > GLOBAL_SEARCH_LIMIT,
  };
}

function toHit(row: Row): GlobalSearchHit {
  const matches: GlobalSearchMatch[] = [];
  if (row.account_match) matches.push({ field: "accountNumber", value: row.account_number });
  if (row.service_match) matches.push({ field: "serviceNumber", value: row.service_match });
  if (row.name_match) matches.push({ field: "name", value: row.full_name });
  if (row.contact_match) matches.push({ field: "contact", value: row.contact_match });
  if (row.address_match) matches.push({ field: "address", value: row.address_match });
  if (row.receipt_match) matches.push({ field: "receiptNumber", value: row.receipt_match });
  if (row.invoice_match) matches.push({ field: "invoiceNumber", value: row.invoice_match });
  if (row.gcash_match) matches.push({ field: "gcashReference", value: row.gcash_match });
  return {
    id: row.id,
    accountNumber: row.account_number,
    fullName: row.full_name,
    status: row.status,
    primaryAddress: row.primary_address,
    primaryContact: row.primary_contact,
    matches,
  };
}
