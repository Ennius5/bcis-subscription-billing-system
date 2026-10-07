import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { writeAudit } from "./audit";

const { db, pool } = createTestDb();
let actorId: string;

async function rowsFor(action: string) {
  return db.select().from(auditLogs).where(eq(auditLogs.action, action));
}

describe("audit log", () => {
  beforeAll(async () => {
    await prepareTestDatabase(db);
    actorId = await createTestUser(db, "audit_actor", "Passw0rd!test", "administrator");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("writes a row and redacts sensitive values", async () => {
    await writeAudit(db, {
      actorUserId: actorId,
      action: "test.write",
      entityType: "test",
      entityId: "abc-123",
      reason: "unit test",
      oldValues: { amount: 50000 },
      newValues: {
        amount: 99900,
        passwordHash: "should-not-appear",
        nested: { token: "should-not-appear", ok: 1 },
      },
    });

    const rows = await rowsFor("test.write");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(actorId);
    expect(rows[0]?.reason).toBe("unit test");
    expect(rows[0]?.oldValues).toEqual({ amount: 50000 });
    expect(rows[0]?.newValues).toEqual({
      amount: 99900,
      passwordHash: "[REDACTED]",
      nested: { token: "[REDACTED]", ok: 1 },
    });
  });

  it("rolls the audit row back when the surrounding transaction fails", async () => {
    await expect(
      db.transaction(async (tx) => {
        await writeAudit(tx, { action: "test.rollback", entityType: "test" });
        throw new Error("simulated failure after audit write");
      }),
    ).rejects.toThrow("simulated failure");

    expect(await rowsFor("test.rollback")).toHaveLength(0);
  });

  it("commits the audit row when the transaction succeeds", async () => {
    await db.transaction(async (tx) => {
      await writeAudit(tx, { action: "test.commit", entityType: "test" });
    });

    expect(await rowsFor("test.commit")).toHaveLength(1);
  });

  it("blocks UPDATE on audit_logs", async () => {
    await writeAudit(db, { action: "test.immutable-update", entityType: "test" });
    await expect(
      pool.query("UPDATE audit_logs SET reason = 'tampered' WHERE action = 'test.immutable-update'"),
    ).rejects.toThrow(/append-only/);
  });

  it("blocks DELETE on audit_logs", async () => {
    await writeAudit(db, { action: "test.immutable-delete", entityType: "test" });
    await expect(
      pool.query("DELETE FROM audit_logs WHERE action = 'test.immutable-delete'"),
    ).rejects.toThrow(/append-only/);
  });
});