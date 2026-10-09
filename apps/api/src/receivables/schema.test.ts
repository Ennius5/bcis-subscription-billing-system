import { sql } from "drizzle-orm";
import { planCreateSchema, serviceAccountCreateSchema, subscriberCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";

// These tests talk to PostgreSQL directly (pool.query), bypassing every service, to prove
// the service-control rules hold at the database level: seeded settings, append-only
// suspension records and a reconnection workflow that only moves forward.

const { db, pool } = createTestDb();
let actorId: string;
let technicianId: string;
let serviceId: string;
let otherServiceId: string;

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(values),
  );
  return result.rows[0]!.id;
}

function suspend(service = serviceId, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert("suspension_records", {
    service_account_id: service,
    effective_date: "2026-10-09",
    reason: "Two months unpaid",
    approved_by: "Owner",
    past_due_invoice_count: 2,
    past_due_centavos: 199_800,
    suspended_by_user_id: actorId,
    ...overrides,
  });
}

function request(suspensionId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return insert("reconnection_records", {
    service_account_id: serviceId,
    suspension_record_id: suspensionId,
    request_date: "2026-10-12",
    requested_by_user_id: actorId,
    fee_centavos: 30_000,
    ...overrides,
  });
}

/** Raw UPDATE of a reconnection; `$2` is the acting user and `$3` the technician (needs `$2` too). */
const update = (id: string, sets: string) =>
  pool.query(
    `UPDATE reconnection_records SET ${sets} WHERE id = $1`,
    // PostgreSQL rejects parameters the statement does not use, so pass only those referenced.
    [id, actorId, technicianId].slice(0, sets.includes("$3") ? 3 : sets.includes("$2") ? 2 : 1),
  );
const assign = (id: string) => update(id, `status = 'assigned', technician_user_id = $3, assigned_by_user_id = $2, assigned_at = now()`);
const complete = (id: string) =>
  update(id, `status = 'completed', completion_date = '2026-10-13', completed_by_user_id = $2, completed_at = now()`);
const cancel = (id: string) =>
  update(id, `status = 'cancelled', cancel_reason = 'Subscriber moved', cancelled_by_user_id = $2, cancelled_at = now()`);

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans CASCADE`);
  actorId = await createTestUser(db, "control_schema_actor", "Passw0rd!test", "administrator");
  technicianId = await createTestUser(db, "control_schema_tech", "Passw0rd!test", "technician");

  const address = { line1: "Purok 3", barangay: "Poblacion", city: "Malaybalay" };
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({ fullName: "Control Test", billingDay: 5, address }),
  );
  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-ctl", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  const create = serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id });
  serviceId = (await createServiceAccount(db, actorId, subscriber.id, create)).id;
  otherServiceId = (await createServiceAccount(db, actorId, subscriber.id, create)).id;
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE suspension_records, reconnection_records CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("settings", () => {
  it("seeds the grace period and suspension threshold", async () => {
    const result = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM application_settings WHERE key IN ('grace_period_days', 'suspension_threshold_invoices') ORDER BY key`,
    );
    expect(result.rows).toEqual([
      { key: "grace_period_days", value: "7" },
      { key: "suspension_threshold_invoices", value: "1" },
    ]);
  });
});

describe("suspension records", () => {
  it("are append-only", async () => {
    const id = await suspend();
    await expect(pool.query(`UPDATE suspension_records SET reason = 'Changed' WHERE id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM suspension_records WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it("require who approved it", async () => {
    await expect(suspend(serviceId, { approved_by: "  " })).rejects.toThrow(/suspension_records_approved_by_present/);
  });
});

describe("reconnection workflow", () => {
  it("goes requested -> assigned -> completed, and completed is final", async () => {
    const id = await request(await suspend());
    await assign(id);
    await complete(id);
    await expect(cancel(id)).rejects.toThrow(/completed and cannot change/);
  });

  it("may skip the technician (requested -> completed)", async () => {
    const id = await request(await suspend());
    await expect(complete(id)).resolves.toBeDefined();
  });

  it("lets an assigned job go to another technician, but not once completed", async () => {
    const id = await request(await suspend());
    await assign(id);
    await expect(update(id, `technician_user_id = $2`)).resolves.toBeDefined();
    await complete(id);
    await expect(update(id, `technician_user_id = $2`)).rejects.toThrow(/cannot change/);
  });

  it("never goes back to requested", async () => {
    const id = await request(await suspend());
    await assign(id);
    await expect(
      update(id, `status = 'requested', technician_user_id = NULL, assigned_by_user_id = NULL, assigned_at = NULL`),
    ).rejects.toThrow(/cannot move from assigned to requested/);
  });

  it("freezes the request and fee", async () => {
    const id = await request(await suspend());
    await expect(update(id, `fee_centavos = 0`)).rejects.toThrow(/request details/);
  });

  it("cannot be deleted", async () => {
    const id = await request(await suspend());
    await expect(pool.query(`DELETE FROM reconnection_records WHERE id = $1`, [id])).rejects.toThrow(/cancel them instead/);
  });

  it("needs a reason to waive the fee", async () => {
    const suspensionId = await suspend();
    await expect(request(suspensionId, { fee_waived: true })).rejects.toThrow(/reconnection_records_waiver_shape/);
    await expect(request(suspensionId, { fee_waived: true, fee_waiver_reason: "Outage was ours" })).resolves.toBeDefined();
  });

  it("needs a technician to be assigned", async () => {
    const id = await request(await suspend());
    await expect(update(id, `status = 'assigned'`)).rejects.toThrow(/reconnection_records_assignment_shape/);
  });

  it("allows one live reconnection per suspension; a cancelled one frees it", async () => {
    const suspensionId = await suspend();
    const first = await request(suspensionId);
    await expect(request(suspensionId)).rejects.toThrow(/reconnection_records_one_(live|per_suspension)_idx/);
    await cancel(first);
    await expect(request(suspensionId)).resolves.toBeDefined();
  });

  it("must lift a suspension of the same service account", async () => {
    const otherSuspension = await suspend(otherServiceId);
    await expect(request(otherSuspension)).rejects.toThrow(/reconnection_records_suspension_fk/);
  });
});
