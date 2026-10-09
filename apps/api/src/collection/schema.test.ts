import { sql } from "drizzle-orm";
import { subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";

// These tests talk to PostgreSQL directly (pool.query), bypassing every service, to prove
// the collection rules hold at the database level: the batch lifecycle, snapshot route
// sheet rows, append-only remittances, frozen reconciliation figures (AT-07/AT-08) and
// field collections tied to an in-progress batch of the right collector.

const { db, pool } = createTestDb();
let actorId: string;
let collectorId: string;
let otherCollectorId: string;
let subscriberId: string;
let otherSubscriberId: string;
let batchNo = 0;
let receiptNo = 0;

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(values),
  );
  return result.rows[0]!.id;
}

function insertBatch(overrides: Record<string, unknown> = {}): Promise<string> {
  batchNo += 1;
  return insert("collection_batches", {
    batch_number: `CB-T${String(batchNo).padStart(5, "0")}`,
    collector_id: collectorId,
    collection_date: "2026-10-10",
    created_by_user_id: actorId,
    ...overrides,
  });
}

function addAccount(batchId: string, subscriber = subscriberId): Promise<string> {
  return insert("batch_accounts", {
    batch_id: batchId,
    subscriber_id: subscriber,
    current_centavos: 99_900,
    arrears_centavos: 0,
    credit_centavos: 0,
    total_due_centavos: 99_900,
    added_by_user_id: actorId,
  });
}

function insertCollection(batchId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  receiptNo += 1;
  return insert("payments", {
    receipt_number: `RCPT-C${String(receiptNo).padStart(5, "0")}`,
    subscriber_id: subscriberId,
    method: "cash",
    amount_centavos: 99_900,
    payment_date: "2026-10-10",
    received_by_user_id: actorId,
    collection_batch_id: batchId,
    collector_id: collectorId,
    ...overrides,
  });
}

function remit(batchId: string, amount: number): Promise<string> {
  return insert("collector_remittances", {
    batch_id: batchId,
    collector_id: collectorId,
    amount_centavos: amount,
    received_by_user_id: actorId,
  });
}

/** Raw UPDATE of a batch; `$2` in `sets` is the acting user. */
const setStatus = (id: string, sets: string) =>
  pool.query(`UPDATE collection_batches SET ${sets} WHERE id = $1`, sets.includes("$2") ? [id, actorId] : [id]);
const dispatch = (id: string) => setStatus(id, `status = 'in_progress', dispatched_at = now(), dispatched_by_user_id = $2`);
const submit = (id: string) => setStatus(id, `status = 'submitted', submitted_at = now(), submitted_by_user_id = $2`);
const reconcile = (id: string, expected: number, remitted: number, kind: string, reason: string | null = null) =>
  pool.query(
    `UPDATE collection_batches SET status = 'reconciled', reconciled_at = now(), reconciled_by_user_id = $2,
       expected_cash_centavos = $3::int, remitted_cash_centavos = $4::int, difference_centavos = $4::int - $3::int,
       variance_kind = $5, variance_reason = $6
     WHERE id = $1`,
    [id, actorId, expected, remitted, kind, reason],
  );

/** A batch that is in progress with the subscriber on it. */
async function batchInProgress(): Promise<string> {
  const id = await insertBatch();
  await addAccount(id);
  await dispatch(id);
  return id;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, collectors CASCADE`);
  actorId = await createTestUser(db, "collection_schema_actor", "Passw0rd!test", "administrator");
  collectorId = await insert("collectors", { code: "COL-T1", full_name: "Collector One" });
  otherCollectorId = await insert("collectors", { code: "COL-T2", full_name: "Collector Two" });
  const address = { line1: "Purok 2", barangay: "Poblacion", city: "Valencia" };
  subscriberId = (await createSubscriber(db, actorId, subscriberCreateSchema.parse({ fullName: "Batch Test", billingDay: 5, address }))).id;
  otherSubscriberId = (
    await createSubscriber(db, actorId, subscriberCreateSchema.parse({ fullName: "Not On Batch", billingDay: 5, address }))
  ).id;
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE collection_batches, batch_accounts, collector_remittances, payments CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("batch numbers", () => {
  it("have their own counter, starting at CB-", async () => {
    const row = await pool.query(`SELECT prefix FROM document_sequences WHERE name = 'collection_batch'`);
    expect(row.rows[0]).toEqual({ prefix: "CB-" });
  });
});

describe("batch lifecycle", () => {
  it("is never deleted", async () => {
    const id = await insertBatch();
    await expect(pool.query(`DELETE FROM collection_batches WHERE id = $1`, [id])).rejects.toThrow(/cancel it instead/);
  });

  it("cannot skip steps", async () => {
    const id = await insertBatch();
    await expect(submit(id)).rejects.toThrow(/cannot move from open to submitted/);
  });

  it("records who dispatched and submitted it", async () => {
    const id = await insertBatch();
    await expect(setStatus(id, `status = 'in_progress'`)).rejects.toThrow(/collection_batches_dispatch_shape/);
    await dispatch(id);
    await expect(setStatus(id, `dispatched_at = now() - interval '1 day'`)).rejects.toThrow(/dispatch details cannot change/);
  });

  it("keeps its collector and date", async () => {
    const id = await insertBatch();
    await expect(pool.query(`UPDATE collection_batches SET collector_id = $2 WHERE id = $1`, [id, otherCollectorId])).rejects.toThrow(
      /cannot change/,
    );
  });

  it("can be cancelled with a reason while nothing is collected, and is then final", async () => {
    const id = await batchInProgress();
    await expect(setStatus(id, `status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2`)).rejects.toThrow(
      /collection_batches_cancel_shape/,
    );
    await setStatus(id, `status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = 'Rain'`);
    await expect(setStatus(id, `notes = 'x'`)).rejects.toThrow(/is cancelled and cannot change/);
  });

  it("cannot be cancelled once a collection is recorded", async () => {
    const id = await batchInProgress();
    await insertCollection(id);
    await expect(
      setStatus(id, `status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = 'Rain'`),
    ).rejects.toThrow(/has recorded collections/);
  });
});

describe("route sheet rows", () => {
  it("must add up: total due = current + arrears - credit, never negative", async () => {
    const id = await insertBatch();
    await expect(
      insert("batch_accounts", {
        batch_id: id,
        subscriber_id: subscriberId,
        current_centavos: 100,
        arrears_centavos: 200,
        credit_centavos: 0,
        total_due_centavos: 100,
        added_by_user_id: actorId,
      }),
    ).rejects.toThrow(/batch_accounts_amounts_valid/);
  });

  it("list a subscriber once per batch", async () => {
    const id = await insertBatch();
    await addAccount(id);
    await expect(addAccount(id)).rejects.toThrow(/batch_accounts_batch_subscriber_idx/);
  });

  it("are a snapshot: never edited", async () => {
    const id = await insertBatch();
    const row = await addAccount(id);
    await expect(pool.query(`UPDATE batch_accounts SET current_centavos = 0, total_due_centavos = 0 WHERE id = $1`, [row])).rejects.toThrow(
      /snapshot/,
    );
  });

  it("can be removed while open, added while in progress, and neither after submission", async () => {
    const id = await insertBatch();
    const row = await addAccount(id);
    await pool.query(`DELETE FROM batch_accounts WHERE id = $1`, [row]);
    const again = await addAccount(id);
    await dispatch(id);
    await expect(pool.query(`DELETE FROM batch_accounts WHERE id = $1`, [again])).rejects.toThrow(/only be removed while/);
    await addAccount(id, otherSubscriberId);
    await submit(id);
    await expect(addAccount(id, otherSubscriberId)).rejects.toThrow(/cannot be added to a submitted/);
  });
});

describe("field collections", () => {
  it("are only for subscribers on the batch", async () => {
    const id = await batchInProgress();
    await expect(insertCollection(id, { subscriber_id: otherSubscriberId })).rejects.toThrow(/payments_batch_account_fk/);
  });

  it("always name the batch's own collector", async () => {
    const id = await batchInProgress();
    await expect(insertCollection(id, { collector_id: otherCollectorId })).rejects.toThrow(/payments_batch_collector_fk/);
    await expect(insertCollection(id, { collector_id: null })).rejects.toThrow(/payments_field_collection_shape/);
  });

  it("are cash or cheque", async () => {
    const id = await batchInProgress();
    await expect(insertCollection(id, { method: "bank_transfer", reference_number: "BANK-1" })).rejects.toThrow(
      /payments_field_collection_shape/,
    );
  });

  it("can only be recorded while the batch is in progress", async () => {
    const id = await insertBatch();
    await addAccount(id);
    await expect(insertCollection(id)).rejects.toThrow(/in-progress batch \(it is open\)/);
    await dispatch(id);
    await insertCollection(id);
    await submit(id);
    await expect(insertCollection(id)).rejects.toThrow(/it is submitted/);
  });

  it("keep their batch and collector once posted", async () => {
    const id = await batchInProgress();
    const payment = await insertCollection(id);
    await expect(pool.query(`UPDATE payments SET collection_batch_id = NULL, collector_id = NULL WHERE id = $1`, [payment])).rejects.toThrow(
      /correct it by reversal/,
    );
  });
});

describe("remittances", () => {
  it("are only recorded after submission", async () => {
    const id = await batchInProgress();
    await expect(remit(id, 99_900)).rejects.toThrow(/in_progress collection batch/);
    await submit(id);
    await remit(id, 99_900);
  });

  it("must name the batch's collector and a positive amount", async () => {
    const id = await batchInProgress();
    await submit(id);
    await expect(remit(id, 0)).rejects.toThrow(/collector_remittances_amount_positive/);
    await expect(
      insert("collector_remittances", { batch_id: id, collector_id: otherCollectorId, amount_centavos: 100, received_by_user_id: actorId }),
    ).rejects.toThrow(/collector_remittances_batch_fk/);
  });

  it("are never edited or deleted, only voided once with a reason", async () => {
    const id = await batchInProgress();
    await submit(id);
    const r = await remit(id, 99_900);
    await expect(pool.query(`UPDATE collector_remittances SET amount_centavos = 1 WHERE id = $1`, [r])).rejects.toThrow(/void it/);
    await expect(pool.query(`DELETE FROM collector_remittances WHERE id = $1`, [r])).rejects.toThrow(/void it instead/);
    await expect(
      pool.query(`UPDATE collector_remittances SET voided_at = now(), voided_by_user_id = $2 WHERE id = $1`, [r, actorId]),
    ).rejects.toThrow(/collector_remittances_void_shape/);
    const voidIt = () =>
      pool.query(
        `UPDATE collector_remittances SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Miscounted' WHERE id = $1`,
        [r, actorId],
      );
    await voidIt();
    await expect(voidIt()).rejects.toThrow(/already voided/);
  });
});

describe("reconciliation (AT-07, AT-08)", () => {
  async function submittedBatch(): Promise<string> {
    const id = await batchInProgress();
    await submit(id);
    return id;
  }

  it("AT-07: ₱20,000 expected and remitted reconciles as balanced with no reason", async () => {
    const id = await submittedBatch();
    await reconcile(id, 2_000_000, 2_000_000, "balanced");
    await setStatus(id, `status = 'closed', closed_at = now(), closed_by_user_id = $2`);
    const row = await pool.query(`SELECT status, difference_centavos, variance_kind FROM collection_batches WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: "closed", difference_centavos: 0, variance_kind: "balanced" });
  });

  it("AT-08: a ₱500 shortage cannot be recorded as balanced or without a reason", async () => {
    const id = await submittedBatch();
    await expect(reconcile(id, 2_000_000, 1_950_000, "balanced", "x")).rejects.toThrow(/collection_batches_variance_consistent/);
    await expect(reconcile(id, 2_000_000, 1_950_000, "shortage")).rejects.toThrow(/collection_batches_variance_consistent/);
    await reconcile(id, 2_000_000, 1_950_000, "shortage", "Collector short ₱500");
    const row = await pool.query(`SELECT difference_centavos, variance_kind FROM collection_batches WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ difference_centavos: -50_000, variance_kind: "shortage" });
  });

  it("freezes the reconciled figures", async () => {
    const id = await submittedBatch();
    await reconcile(id, 2_000_000, 2_000_000, "balanced");
    await expect(
      setStatus(id, `remitted_cash_centavos = 1_950_000, difference_centavos = -50_000, variance_kind = 'shortage', variance_reason = 'Later'`),
    ).rejects.toThrow(/figures cannot change/);
  });

  it("stops remittances once reconciled", async () => {
    const id = await submittedBatch();
    await reconcile(id, 0, 0, "balanced");
    await expect(remit(id, 100)).rejects.toThrow(/reconciled collection batch/);
  });

  it("must come before closing, and closed is final", async () => {
    const id = await submittedBatch();
    await expect(setStatus(id, `status = 'closed', closed_at = now(), closed_by_user_id = $2`)).rejects.toThrow(
      /cannot move from submitted to closed/,
    );
    await reconcile(id, 0, 0, "balanced");
    await setStatus(id, `status = 'closed', closed_at = now(), closed_by_user_id = $2`);
    await expect(setStatus(id, `notes = 'late note'`)).rejects.toThrow(/is closed and cannot change/);
  });
});
