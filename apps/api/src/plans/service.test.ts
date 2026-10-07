import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { planCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { createPlan, listPlans, updatePlan } from "./service";

const { db, pool } = createTestDb();
let actorId: string;

const internetPlan = planCreateSchema.parse({
  code: "inet-10",
  name: "Internet 10 Mbps",
  serviceType: "internet",
  priceCentavos: 99900,
  speedMbps: 10,
});

async function auditFor(action: string, entityId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

describe("plans service", () => {
  beforeAll(async () => {
    await prepareTestDatabase(db);
    await db.execute(sql`TRUNCATE service_plans CASCADE`);
    actorId = await createTestUser(db, "plan_actor", "Passw0rd!test", "administrator");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a plan and writes a plan.create audit row", async () => {
    const plan = await createPlan(db, actorId, internetPlan);
    expect(plan.code).toBe("INET-10");
    expect(plan.serviceType).toBe("internet");
    expect(plan.priceCentavos).toBe(99900);
    expect(plan.isActive).toBe(true);

    const audit = await auditFor("plan.create", plan.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(actorId);
  });

  it("rejects a duplicate plan code", async () => {
    await expect(createPlan(db, actorId, internetPlan)).rejects.toMatchObject({
      code: "CODE_TAKEN",
      status: 409,
    });
  });

  it("updates a price and audits the old and new values with the reason", async () => {
    const [plan] = await listPlans(db);
    if (!plan) throw new Error("expected a plan");

    const updated = await updatePlan(db, actorId, plan.id, {
      priceCentavos: 109900,
      reason: "annual adjustment",
    });
    expect(updated.priceCentavos).toBe(109900);

    const audit = await auditFor("plan.update", plan.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("annual adjustment");
    expect(audit[0]?.oldValues).toEqual({ priceCentavos: 99900 });
    expect(audit[0]?.newValues).toEqual({ priceCentavos: 109900 });
  });

  it("rejects a channel count on an internet plan and leaves no audit row", async () => {
    const [plan] = await listPlans(db);
    if (!plan) throw new Error("expected a plan");

    await expect(
      updatePlan(db, actorId, plan.id, { channelCount: 50 }),
    ).rejects.toMatchObject({ code: "INVALID_ATTRIBUTES", status: 422 });

    const [after] = await listPlans(db);
    expect(after?.channelCount).toBeNull();
    // Only the one successful update from the previous test exists.
    expect(await auditFor("plan.update", plan.id)).toHaveLength(1);
  });

  it("reports NOT_FOUND for an unknown plan", async () => {
    await expect(
      updatePlan(db, actorId, randomUUID(), { name: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("hides inactive plans unless asked", async () => {
    const [plan] = await listPlans(db);
    if (!plan) throw new Error("expected a plan");

    await updatePlan(db, actorId, plan.id, { isActive: false });

    expect(await listPlans(db)).toHaveLength(0);
    expect(await listPlans(db, { includeInactive: true })).toHaveLength(1);
  });
});