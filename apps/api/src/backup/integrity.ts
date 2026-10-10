import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { expectedMigrationCount } from "../db/migrations-folder";

/**
 * The integrity check (Phase 9 decision 5). Plain SQL over any connection, so the same
 * checks run on the live database, on a test restore in bcis_verify, and right after a
 * real restore. Each check compares two independent records of the same money, or a
 * record with the file it points to; any difference means corruption or a lost row.
 */

/** Anything that runs a query: a pg Pool, a pg Client. */
export interface Queryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export interface IntegrityCheck {
  code: string;
  label: string;
  passed: boolean;
  /** Plain words: what was compared, and what differs when it fails. */
  detail: string;
}

export interface IntegrityReport {
  passed: boolean;
  checks: IntegrityCheck[];
}

/** Lists the first few offenders so the report stays short but actionable. */
function sample(items: readonly string[], total: number): string {
  const shown = items.slice(0, 5);
  return total > shown.length ? `${shown.join(", ")} and ${total - shown.length} more` : shown.join(", ");
}

async function countAndSample(db: Queryable, text: string): Promise<{ total: number; examples: string[] }> {
  const rows = (await db.query(
    `WITH bad AS (${text}) SELECT label, count(*) OVER ()::text AS total FROM bad LIMIT 5`,
  )).rows as { label: string; total: string }[];
  return { total: Number(rows[0]?.total ?? 0), examples: rows.map((r) => r.label) };
}

async function migrationsCheck(db: Queryable): Promise<IntegrityCheck> {
  const expected = await expectedMigrationCount();
  const [row] = (await db.query(
    "SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations",
  )).rows as { applied: number }[];
  const applied = row?.applied ?? 0;
  return {
    code: "migrations",
    label: "Database structure matches this version of the system",
    passed: applied === expected,
    detail:
      applied === expected
        ? `All ${expected} migrations are applied.`
        : `${applied} migrations are applied but this version expects ${expected}.`,
  };
}

async function invoicePaidCheck(db: Queryable): Promise<IntegrityCheck> {
  // Paid amount on each invoice = allocations of payments that are still posted.
  const { total, examples } = await countAndSample(
    db,
    `SELECT coalesce(i.invoice_number, i.id::text) AS label
       FROM invoices i
       LEFT JOIN (SELECT a.invoice_id, sum(a.amount_centavos) AS paid
                    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                   WHERE p.status = 'posted'
                   GROUP BY a.invoice_id) s ON s.invoice_id = i.id
      WHERE i.paid_centavos <> coalesce(s.paid, 0)`,
  );
  return {
    code: "invoice_paid",
    label: "Invoice paid amounts match their payment allocations",
    passed: total === 0,
    detail: total === 0 ? "Every invoice's paid amount equals its allocations." : `Mismatch on ${sample(examples, total)}.`,
  };
}

async function paymentAllocatedCheck(db: Queryable): Promise<IntegrityCheck> {
  const { total, examples } = await countAndSample(
    db,
    `SELECT p.receipt_number AS label
       FROM payments p
       LEFT JOIN (SELECT payment_id, sum(amount_centavos) AS allocated
                    FROM payment_allocations GROUP BY payment_id) s ON s.payment_id = p.id
      WHERE p.allocated_centavos <> coalesce(s.allocated, 0)
         OR coalesce(s.allocated, 0) > p.amount_centavos`,
  );
  return {
    code: "payment_allocated",
    label: "No payment is allocated beyond its amount",
    passed: total === 0,
    detail:
      total === 0
        ? "Every payment's allocations add up to its allocated amount, never more than it paid."
        : `Problem on ${sample(examples, total)}.`,
  };
}

async function ledgerCheck(db: Queryable): Promise<IntegrityCheck> {
  // The ledger total per subscriber, against the same money rebuilt from the source records:
  // finalized, non-void invoices (with adjustments) minus posted payments. Reversals and
  // voids net to zero in the ledger, so they drop out on both sides.
  const { total, examples } = await countAndSample(
    db,
    `WITH ledger AS (
        SELECT subscriber_id, sum(debit_centavos - credit_centavos) AS balance
          FROM ledger_entries GROUP BY subscriber_id),
      billed AS (
        SELECT subscriber_id, sum(total_centavos + adjusted_centavos) AS amount
          FROM invoices WHERE status NOT IN ('draft', 'void') GROUP BY subscriber_id),
      paid AS (
        SELECT subscriber_id, sum(amount_centavos) AS amount
          FROM payments WHERE status = 'posted' GROUP BY subscriber_id)
     SELECT s.account_number AS label
       FROM subscribers s
       LEFT JOIN ledger l ON l.subscriber_id = s.id
       LEFT JOIN billed b ON b.subscriber_id = s.id
       LEFT JOIN paid p ON p.subscriber_id = s.id
      WHERE coalesce(l.balance, 0) <> coalesce(b.amount, 0) - coalesce(p.amount, 0)`,
  );
  return {
    code: "ledger_balance",
    label: "Every subscriber's ledger balance matches invoices, adjustments and payments",
    passed: total === 0,
    detail: total === 0 ? "All ledger balances reconcile." : `Balance differs for ${sample(examples, total)}.`,
  };
}

/** Each numbered series and the column holding its issued numbers. Fixed names only. */
const SERIES = [
  { name: "invoice", table: "invoices", column: "invoice_number" },
  { name: "receipt", table: "payments", column: "receipt_number" },
  { name: "adjustment", table: "adjustments", column: "adjustment_number" },
  { name: "collection_batch", table: "collection_batches", column: "batch_number" },
  { name: "backup", table: "backup_history", column: "backup_number" },
] as const;

async function countersCheck(db: Queryable): Promise<IntegrityCheck> {
  const behind: string[] = [];
  for (const s of SERIES) {
    const [row] = (await db.query(
      `SELECT q.prefix, q.next_value::text AS next,
              (SELECT max(substring(t.${s.column} FROM '^' || q.prefix || '(\\d+)$')::bigint)::text
                 FROM ${s.table} t) AS highest
         FROM document_sequences q WHERE q.name = '${s.name}'`,
    )).rows as { prefix: string; next: string; highest: string | null }[];
    if (!row) {
      behind.push(`${s.name} (counter missing)`);
    } else if (row.highest !== null && Number(row.highest) >= Number(row.next)) {
      behind.push(`${row.prefix} (next ${row.next}, already issued ${row.highest})`);
    }
  }
  return {
    code: "counters",
    label: "Document counters are ahead of every number already issued",
    passed: behind.length === 0,
    detail:
      behind.length === 0
        ? "Invoice, receipt, adjustment, batch and backup numbers cannot repeat."
        : `Would repeat a number: ${behind.join("; ")}.`,
  };
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function proofsCheck(db: Queryable, proofDir: string): Promise<IntegrityCheck> {
  const proofs = (await db.query(
    "SELECT storage_key, size_bytes, sha256 FROM payment_proofs ORDER BY uploaded_at",
  )).rows as { storage_key: string; size_bytes: number; sha256: string }[];
  const missing: string[] = [];
  const changed: string[] = [];
  for (const proof of proofs) {
    const file = path.join(proofDir, proof.storage_key);
    try {
      const info = await stat(file);
      if (info.size !== proof.size_bytes || (await sha256OfFile(file)) !== proof.sha256) changed.push(proof.storage_key);
    } catch {
      missing.push(proof.storage_key);
    }
  }
  const problems = [
    ...(missing.length ? [`missing: ${sample(missing, missing.length)}`] : []),
    ...(changed.length ? [`changed: ${sample(changed, changed.length)}`] : []),
  ];
  return {
    code: "proof_files",
    label: "Every payment proof image is present and unchanged",
    passed: problems.length === 0,
    detail: problems.length === 0 ? `All ${proofs.length} proof images match their checksums.` : `Proof images ${problems.join("; ")}.`,
  };
}

/** Rows per table against the counts a backup's manifest recorded. Used after restores. */
export async function rowCountsCheck(db: Queryable, expected: Record<string, number>): Promise<IntegrityCheck> {
  const tables = Object.keys(expected).filter((t) => /^[a-z_]+$/.test(t));
  const [row] = (await db.query(
    `SELECT ${tables.map((t) => `(SELECT count(*) FROM ${t})::text AS ${t}`).join(", ")}`,
  )).rows as Record<string, string>[];
  const differences = tables
    .filter((t) => Number(row?.[t] ?? -1) !== expected[t])
    .map((t) => `${t} ${row?.[t] ?? "missing"} instead of ${expected[t]}`);
  return {
    code: "row_counts",
    label: "Every record in the backup came back",
    passed: differences.length === 0,
    detail:
      differences.length === 0
        ? `Row counts of ${tables.length} key tables match the backup's manifest.`
        : `Different: ${differences.join("; ")}.`,
  };
}

export async function runIntegrityChecks(
  db: Queryable,
  options: { proofDir: string; expectedRowCounts?: Record<string, number> },
): Promise<IntegrityReport> {
  const checks = [
    await migrationsCheck(db),
    await invoicePaidCheck(db),
    await paymentAllocatedCheck(db),
    await ledgerCheck(db),
    await countersCheck(db),
    await proofsCheck(db, options.proofDir),
  ];
  if (options.expectedRowCounts) checks.push(await rowCountsCheck(db, options.expectedRowCounts));
  return { passed: checks.every((c) => c.passed), checks };
}
