import { sql } from "drizzle-orm";
import { planCreateSchema, serviceAccountCreateSchema, subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";

// These tests talk to PostgreSQL directly (pool.query), bypassing every service, to prove
// the payment rules hold at the database level: posted payments are never edited or
// deleted, allocations stay within one subscriber, history tables are append-only and a
// GCash reference can be live only once (AT-05).

const { db, pool } = createTestDb();
let actorId: string;
let subscriberId: string;
let otherSubscriberId: string;
let otherInvoiceId: string;
let invoiceId: string;
let receiptNo = 0;

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(values),
  );
  return result.rows[0]!.id;
}

function insertPayment(overrides: Record<string, unknown> = {}): Promise<string> {
  receiptNo += 1;
  return insert("payments", {
    receipt_number: `RCPT-T${String(receiptNo).padStart(5, "0")}`,
    subscriber_id: subscriberId,
    method: "cash",
    amount_centavos: 99_900,
    payment_date: "2026-09-05",
    received_by_user_id: actorId,
    ...overrides,
  });
}

function insertSubmission(overrides: Record<string, unknown> = {}): Promise<string> {
  return insert("gcash_submissions", {
    subscriber_id: subscriberId,
    reference_number: "1012345678901",
    sender_name: "Demo Sender",
    sender_number: "09170000001",
    amount_centavos: 99_900,
    transaction_date: "2026-09-20",
    recorded_by_user_id: actorId,
    ...overrides,
  });
}

function insertAllocation(paymentId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert("payment_allocations", {
    payment_id: paymentId,
    invoice_id: invoiceId,
    subscriber_id: subscriberId,
    amount_centavos: 50_000,
    source: "auto",
    allocated_by_user_id: actorId,
    ...overrides,
  });
}

async function finalizedInvoice(subscriber: string, service: string, cycle: string, number: string) {
  const id = await insert("invoices", {
    billing_cycle_id: cycle,
    subscriber_id: subscriber,
    service_account_id: service,
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    invoice_date: "2026-09-01",
    due_date: "2026-09-05",
    total_centavos: 99_900,
    created_by_user_id: actorId,
  });
  await pool.query(
    `UPDATE invoices SET status = 'unpaid', invoice_number = $2, finalized_at = now(), finalized_by_user_id = $3 WHERE id = $1`,
    [id, number, actorId],
  );
  return id;
}

let serviceId: string;
let otherServiceId: string;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "payment_schema_actor", "Passw0rd!test", "administrator");

  const address = { line1: "Purok 1", barangay: "Poblacion", city: "Maramag" };
  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-pay", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  const makeSubscriber = async (fullName: string) => {
    const subscriber = await createSubscriber(db, actorId, subscriberCreateSchema.parse({ fullName, billingDay: 5, address }));
    const service = await createServiceAccount(
      db,
      actorId,
      subscriber.id,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
    );
    return { subscriberId: subscriber.id, serviceId: service.id };
  };
  ({ subscriberId, serviceId } = await makeSubscriber("Payment Test"));
  ({ subscriberId: otherSubscriberId, serviceId: otherServiceId } = await makeSubscriber("Someone Else"));
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE billing_cycles, invoices, invoice_items, ledger_entries, payments, payment_allocations,
        payment_reversals, gcash_submissions, payment_proofs CASCADE`,
  );
  const cycleId = await insert("billing_cycles", {
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    created_by_user_id: actorId,
  });
  invoiceId = await finalizedInvoice(subscriberId, serviceId, cycleId, "INV-P00001");
  otherInvoiceId = await finalizedInvoice(otherSubscriberId, otherServiceId, cycleId, "INV-P00002");
});

afterAll(async () => {
  await pool.end();
});

describe("receipt numbers", () => {
  it("have their own counter, starting at RCPT-", async () => {
    const row = await pool.query(`SELECT prefix FROM document_sequences WHERE name = 'receipt'`);
    expect(row.rows[0]).toEqual({ prefix: "RCPT-" });
  });

  it("are unique", async () => {
    await insertPayment({ receipt_number: "RCPT-DUP" });
    await expect(insertPayment({ receipt_number: "RCPT-DUP" })).rejects.toThrow(/payments_receipt_number_unique/);
  });
});

describe("payment shape", () => {
  it("refuses zero amounts and over-allocation", async () => {
    await expect(insertPayment({ amount_centavos: 0 })).rejects.toThrow(/payments_amount_positive/);
    await expect(insertPayment({ allocated_centavos: 100_000 })).rejects.toThrow(/payments_allocated_range/);
  });

  it("only accepts GCash payments that come from a submission, with their reference", async () => {
    await expect(insertPayment({ method: "gcash", reference_number: "1012345678901" })).rejects.toThrow(
      /payments_gcash_shape/,
    );
    const submission = await insertSubmission();
    await expect(insertPayment({ method: "cash", gcash_submission_id: submission })).rejects.toThrow(
      /payments_gcash_shape/,
    );
    await expect(insertPayment({ method: "gcash", gcash_submission_id: submission })).rejects.toThrow(
      /payments_gcash_shape/,
    );
  });
});

describe("posted payments are never edited or deleted", () => {
  it("blocks changing what was received, and deleting", async () => {
    const id = await insertPayment();
    await expect(pool.query(`UPDATE payments SET amount_centavos = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /correct it by reversal/,
    );
    await expect(pool.query(`UPDATE payments SET subscriber_id = $2 WHERE id = $1`, [id, otherSubscriberId])).rejects.toThrow(
      /correct it by reversal/,
    );
    await expect(pool.query(`DELETE FROM payments WHERE id = $1`, [id])).rejects.toThrow(/reverse it instead/);
  });

  it("lets allocation move allocated_centavos, then reversal end it", async () => {
    const id = await insertPayment();
    await pool.query(`UPDATE payments SET allocated_centavos = 50000 WHERE id = $1`, [id]);
    await pool.query(`UPDATE payments SET status = 'reversed' WHERE id = $1`, [id]);
    await expect(pool.query(`UPDATE payments SET allocated_centavos = 0 WHERE id = $1`, [id])).rejects.toThrow(
      /is reversed and cannot change/,
    );
    await expect(pool.query(`UPDATE payments SET status = 'posted' WHERE id = $1`, [id])).rejects.toThrow(
      /is reversed and cannot change/,
    );
  });
});

describe("allocations", () => {
  it("can only pay the payment's own subscriber's invoices", async () => {
    const id = await insertPayment();
    await expect(insertAllocation(id, { invoice_id: otherInvoiceId })).rejects.toThrow(/payment_allocations_invoice_fk/);
    await expect(
      insertAllocation(id, { invoice_id: otherInvoiceId, subscriber_id: otherSubscriberId }),
    ).rejects.toThrow(/payment_allocations_payment_fk/);
  });

  it("are positive and append-only", async () => {
    const id = await insertPayment();
    await expect(insertAllocation(id, { amount_centavos: 0 })).rejects.toThrow(/payment_allocations_amount_positive/);
    const allocation = await insertAllocation(id);
    await expect(
      pool.query(`UPDATE payment_allocations SET amount_centavos = 1 WHERE id = $1`, [allocation]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM payment_allocations WHERE id = $1`, [allocation])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("reversals", () => {
  it("happen at most once per payment and are append-only", async () => {
    const payment = await insertPayment();
    const values = { payment_id: payment, reason: "Wrong subscriber", reversed_by_user_id: actorId };
    const id = await insert("payment_reversals", values);
    await expect(insert("payment_reversals", values)).rejects.toThrow(/payment_reversals_payment_id_unique/);
    await expect(pool.query(`DELETE FROM payment_reversals WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });
});

describe("AT-05: a GCash reference is live only once", () => {
  it("blocks a second pending or verified submission with the same reference", async () => {
    await insertSubmission();
    await expect(insertSubmission()).rejects.toThrow(/gcash_submissions_live_reference_idx/);
  });

  it("frees the reference when the submission is rejected", async () => {
    const id = await insertSubmission();
    await pool.query(
      `UPDATE gcash_submissions SET status = 'rejected', reviewed_at = now(), reviewed_by_user_id = $2,
       rejection_reason = 'Amount does not match' WHERE id = $1`,
      [id, actorId],
    );
    await expect(insertSubmission()).resolves.toBeTypeOf("string");
  });

  it("frees the reference when the verified payment is reversed", async () => {
    const id = await insertSubmission();
    await pool.query(
      `UPDATE gcash_submissions SET status = 'verified', reviewed_at = now(), reviewed_by_user_id = $2 WHERE id = $1`,
      [id, actorId],
    );
    await expect(insertSubmission()).rejects.toThrow(/gcash_submissions_live_reference_idx/);
    await pool.query(`UPDATE gcash_submissions SET status = 'reversed' WHERE id = $1`, [id]);
    await expect(insertSubmission()).resolves.toBeTypeOf("string");
  });
});

describe("GCash submission review", () => {
  it("records who reviewed it, and why a rejection was made", async () => {
    const id = await insertSubmission();
    await expect(pool.query(`UPDATE gcash_submissions SET status = 'verified' WHERE id = $1`, [id])).rejects.toThrow(
      /gcash_submissions_review_shape/,
    );
    await expect(
      pool.query(
        `UPDATE gcash_submissions SET status = 'rejected', reviewed_at = now(), reviewed_by_user_id = $2 WHERE id = $1`,
        [id, actorId],
      ),
    ).rejects.toThrow(/gcash_submissions_review_shape/);
  });

  it("lets a pending submission be corrected, but freezes it once reviewed", async () => {
    const id = await insertSubmission();
    await pool.query(`UPDATE gcash_submissions SET amount_centavos = 50000 WHERE id = $1`, [id]);
    await expect(pool.query(`UPDATE gcash_submissions SET status = 'reversed' WHERE id = $1`, [id])).rejects.toThrow(
      /reject it instead/,
    );
    await pool.query(
      `UPDATE gcash_submissions SET status = 'verified', reviewed_at = now(), reviewed_by_user_id = $2 WHERE id = $1`,
      [id, actorId],
    );
    await expect(pool.query(`UPDATE gcash_submissions SET amount_centavos = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /verified and cannot change/,
    );
    await expect(
      pool.query(`UPDATE gcash_submissions SET status = 'reversed', amount_centavos = 1 WHERE id = $1`, [id]),
    ).rejects.toThrow(/details cannot change/);
    await expect(pool.query(`DELETE FROM gcash_submissions WHERE id = $1`, [id])).rejects.toThrow(/reject it instead/);
  });

  it("treats rejected as final", async () => {
    const id = await insertSubmission();
    await pool.query(
      `UPDATE gcash_submissions SET status = 'rejected', reviewed_at = now(), reviewed_by_user_id = $2,
       rejection_reason = 'Not found in GCash history' WHERE id = $1`,
      [id, actorId],
    );
    await expect(
      pool.query(`UPDATE gcash_submissions SET status = 'pending', reviewed_at = NULL, reviewed_by_user_id = NULL,
                  rejection_reason = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/rejected and cannot change/);
  });
});

describe("payment proofs", () => {
  const proof = (overrides: Record<string, unknown>) =>
    insert("payment_proofs", {
      storage_key: `${crypto.randomUUID()}.png`,
      mime_type: "image/png",
      size_bytes: 1024,
      sha256: "a".repeat(64),
      uploaded_by_user_id: actorId,
      ...overrides,
    });

  it("belong to exactly one submission or payment", async () => {
    const submission = await insertSubmission();
    const payment = await insertPayment();
    await expect(proof({})).rejects.toThrow(/payment_proofs_one_owner/);
    await expect(proof({ gcash_submission_id: submission, payment_id: payment })).rejects.toThrow(
      /payment_proofs_one_owner/,
    );
    await expect(proof({ gcash_submission_id: submission })).resolves.toBeTypeOf("string");
  });

  it("must be a small PNG, JPEG or WebP image, and are append-only", async () => {
    const submission = await insertSubmission();
    await expect(proof({ gcash_submission_id: submission, mime_type: "application/pdf" })).rejects.toThrow(
      /payment_proofs_mime_valid/,
    );
    await expect(proof({ gcash_submission_id: submission, size_bytes: 6 * 1024 * 1024 })).rejects.toThrow(
      /payment_proofs_size_valid/,
    );
    const id = await proof({ gcash_submission_id: submission });
    await expect(pool.query(`DELETE FROM payment_proofs WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });
});
