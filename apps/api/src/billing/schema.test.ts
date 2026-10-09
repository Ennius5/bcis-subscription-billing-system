import { sql } from "drizzle-orm";
import { planCreateSchema, serviceAccountCreateSchema, subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";

// These tests talk to PostgreSQL directly (pool.query), bypassing every service, to prove
// the billing rules hold at the database level: AT-11, immutable finalized invoices,
// draft-only line edits and an append-only ledger.

const { db, pool } = createTestDb();
let actorId: string;
let subscriberId: string;
let otherSubscriberId: string;
let serviceId: string;
let cycleId: string;

async function insertInvoice(overrides: Record<string, unknown> = {}): Promise<string> {
  const values = {
    billing_cycle_id: cycleId,
    subscriber_id: subscriberId,
    service_account_id: serviceId,
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    invoice_date: "2026-09-01",
    due_date: "2026-09-05",
    total_centavos: 99_900,
    created_by_user_id: actorId,
    ...overrides,
  };
  const columns = Object.keys(values);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO invoices (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(values),
  );
  return result.rows[0]!.id;
}

async function finalize(id: string, number: string) {
  await pool.query(
    `UPDATE invoices SET status = 'unpaid', invoice_number = $2, finalized_at = now(), finalized_by_user_id = $3 WHERE id = $1`,
    [id, number, actorId],
  );
}

async function addLine(invoiceId: string, lineNo = 1) {
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, line_no, item_type, description, amount_centavos)
     VALUES ($1, $2, 'subscription', 'September Internet', 99900)`,
    [invoiceId, lineNo],
  );
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "billing_schema_actor", "Passw0rd!test", "administrator");

  const address = { line1: "Purok 1", barangay: "Poblacion", city: "Maramag" };
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({ fullName: "Ledger Test", billingDay: 5, address }),
  );
  subscriberId = subscriber.id;
  otherSubscriberId = (
    await createSubscriber(db, actorId, subscriberCreateSchema.parse({ fullName: "Someone Else", billingDay: 5, address }))
  ).id;
  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-sch", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  serviceId = (
    await createServiceAccount(
      db,
      actorId,
      subscriberId,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
    )
  ).id;
});

beforeEach(async () => {
  // Invoices and ledger rows are append-only or protected, so each test starts from a clean cycle.
  await db.execute(sql`TRUNCATE billing_cycles, invoices, invoice_items, ledger_entries CASCADE`);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2026-09-01', '2026-09-30', $1) RETURNING id`,
    [actorId],
  );
  cycleId = result.rows[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("billing cycles", () => {
  it("must cover exactly one calendar month", async () => {
    await expect(
      pool.query(
        `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2026-10-02', '2026-10-31', $1)`,
        [actorId],
      ),
    ).rejects.toThrow(/billing_cycles_first_of_month/);
    await expect(
      pool.query(
        `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2026-10-01', '2026-10-30', $1)`,
        [actorId],
      ),
    ).rejects.toThrow(/billing_cycles_whole_month/);
  });
});

describe("AT-11: no duplicate billing", () => {
  it("allows only one live invoice per service account and month", async () => {
    await insertInvoice();
    await expect(insertInvoice()).rejects.toThrow(/invoices_one_per_period_idx/);
  });

  it("frees the month again once the invoice is voided", async () => {
    const first = await insertInvoice();
    await finalize(first, "INV-T00001");
    await pool.query(
      `UPDATE invoices SET status = 'void', voided_at = now(), voided_by_user_id = $2, void_reason = 'Wrong rate' WHERE id = $1`,
      [first, actorId],
    );
    await expect(insertInvoice()).resolves.toBeTypeOf("string");
  });
});

describe("invoice shape", () => {
  it("refuses a service account that belongs to another subscriber", async () => {
    await expect(insertInvoice({ subscriber_id: otherSubscriberId })).rejects.toThrow(/invoices_service_account_fk/);
  });

  it("refuses a finalized status without a number, and a void without a reason", async () => {
    await expect(insertInvoice({ status: "unpaid" })).rejects.toThrow(/invoices_draft_shape/);
    const id = await insertInvoice();
    await finalize(id, "INV-T00002");
    await expect(
      pool.query(`UPDATE invoices SET status = 'void', voided_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/invoices_void_shape/);
  });

  it("keeps payments within the total", async () => {
    const id = await insertInvoice();
    await expect(pool.query(`UPDATE invoices SET paid_centavos = 100000 WHERE id = $1`, [id])).rejects.toThrow(
      /invoices_paid_range/,
    );
  });
});

describe("finalized invoices are immutable", () => {
  it("lets a draft change freely and be deleted with its lines", async () => {
    const id = await insertInvoice();
    await addLine(id);
    await pool.query(`UPDATE invoices SET total_centavos = 89900 WHERE id = $1`, [id]);
    await pool.query(`UPDATE invoice_items SET amount_centavos = 89900 WHERE invoice_id = $1`, [id]);
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [id]);
    const left = await pool.query(`SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [id]);
    expect(left.rows[0].n).toBe(0);
  });

  it("blocks changing billed details, deleting, or going back to draft", async () => {
    const id = await insertInvoice();
    await addLine(id);
    await finalize(id, "INV-T00003");

    await expect(pool.query(`UPDATE invoices SET total_centavos = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /billed details cannot change/,
    );
    await expect(pool.query(`UPDATE invoices SET due_date = '2026-09-30' WHERE id = $1`, [id])).rejects.toThrow(
      /billed details cannot change/,
    );
    await expect(pool.query(`UPDATE invoices SET invoice_number = 'INV-X' WHERE id = $1`, [id])).rejects.toThrow(
      /billed details cannot change/,
    );
    await expect(pool.query(`DELETE FROM invoices WHERE id = $1`, [id])).rejects.toThrow(/void it instead/);
    await expect(
      pool.query(`UPDATE invoices SET status = 'draft', invoice_number = NULL, finalized_at = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it("still lets payments move a finalized invoice along", async () => {
    const id = await insertInvoice();
    await finalize(id, "INV-T00004");
    await pool.query(`UPDATE invoices SET paid_centavos = 50000, status = 'partially_paid' WHERE id = $1`, [id]);
    const row = await pool.query(`SELECT status, paid_centavos FROM invoices WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: "partially_paid", paid_centavos: 50000 });
  });

  it("locks the lines of a finalized invoice", async () => {
    const id = await insertInvoice();
    await addLine(id);
    await finalize(id, "INV-T00005");
    await expect(pool.query(`UPDATE invoice_items SET amount_centavos = 1 WHERE invoice_id = $1`, [id])).rejects.toThrow(
      /finalized invoice cannot be changed/,
    );
    await expect(pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id])).rejects.toThrow(
      /finalized invoice cannot be changed/,
    );
    await expect(addLine(id, 2)).rejects.toThrow(/finalized invoice cannot be changed/);
  });

  it("makes a void final", async () => {
    const id = await insertInvoice();
    await finalize(id, "INV-T00006");
    await pool.query(
      `UPDATE invoices SET status = 'void', voided_at = now(), voided_by_user_id = $2, void_reason = 'Duplicate' WHERE id = $1`,
      [id, actorId],
    );
    await expect(pool.query(`UPDATE invoices SET void_reason = 'Changed my mind' WHERE id = $1`, [id])).rejects.toThrow(
      /is void and cannot change/,
    );
  });
});

describe("ledger", () => {
  async function addEntry(debit: number, credit: number) {
    await pool.query(
      `INSERT INTO ledger_entries (subscriber_id, service_account_id, entry_date, entry_type, reference, description, debit_centavos, credit_centavos, created_by_user_id)
       VALUES ($1, $2, '2026-09-01', 'invoice', 'INV-T', 'September Internet', $3, $4, $5)`,
      [subscriberId, serviceId, debit, credit, actorId],
    );
  }

  it("puts the amount on exactly one side", async () => {
    await addEntry(99_900, 0);
    await expect(addEntry(0, 0)).rejects.toThrow(/ledger_entries_one_side/);
    await expect(addEntry(100, 100)).rejects.toThrow(/ledger_entries_one_side/);
    await expect(addEntry(-100, 0)).rejects.toThrow(/ledger_entries_one_side/);
  });

  it("is append-only", async () => {
    await addEntry(99_900, 0);
    await expect(pool.query(`UPDATE ledger_entries SET debit_centavos = 1`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
  });

  it("numbers entries in posting order", async () => {
    await addEntry(99_900, 0);
    await addEntry(0, 50_000);
    const rows = await pool.query<{ seq: string }>(
      `SELECT seq FROM ledger_entries WHERE subscriber_id = $1 ORDER BY seq`,
      [subscriberId],
    );
    expect(Number(rows.rows[1]!.seq)).toBeGreaterThan(Number(rows.rows[0]!.seq));
  });
});

describe("document numbers", () => {
  it("starts the invoice sequence at 1 with the INV- prefix", async () => {
    const row = await pool.query(`SELECT prefix, next_value FROM document_sequences WHERE name = 'invoice'`);
    expect(row.rows[0]).toMatchObject({ prefix: "INV-" });
    expect(Number(row.rows[0].next_value)).toBeGreaterThanOrEqual(1);
  });
});
