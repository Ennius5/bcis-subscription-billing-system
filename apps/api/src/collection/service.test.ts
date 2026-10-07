import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { areaCreateSchema, collectorCreateSchema } from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, collectors } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import {
  createArea,
  createCollector,
  listAreas,
  listCollectors,
  updateArea,
  updateCollector,
} from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let loginUserId: string;

async function auditFor(action: string, entityId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "collection_actor", "Passw0rd!test", "administrator");
  loginUserId = await createTestUser(db, "collector_login", "Passw0rd!test", "collection_supervisor");
});

afterAll(async () => {
  await pool.end();
});

describe("collection areas service", () => {
  const zone1 = areaCreateSchema.parse({ code: "zone-1", name: "Zone 1 - Poblacion" });
  let areaId: string;

  it("creates an area and writes a collection_area.create audit row", async () => {
    const area = await createArea(db, actorId, zone1);
    areaId = area.id;
    expect(area.code).toBe("ZONE-1");
    expect(area.description).toBeNull();
    expect(area.isActive).toBe(true);

    const audit = await auditFor("collection_area.create", area.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(actorId);
  });

  it("rejects a duplicate area code", async () => {
    await expect(createArea(db, actorId, zone1)).rejects.toMatchObject({
      code: "CODE_TAKEN",
      status: 409,
    });
  });

  it("updates fields and audits old and new values with the reason", async () => {
    const updated = await updateArea(db, actorId, areaId, {
      name: "Zone 1 - Centro",
      description: "Main road side",
      reason: "renamed",
    });
    expect(updated.name).toBe("Zone 1 - Centro");

    const audit = await auditFor("collection_area.update", areaId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("renamed");
    expect(audit[0]?.oldValues).toEqual({ name: "Zone 1 - Poblacion", description: null });
    expect(audit[0]?.newValues).toEqual({ name: "Zone 1 - Centro", description: "Main road side" });
  });

  it("audits only the fields that actually changed", async () => {
    await updateArea(db, actorId, areaId, {
      name: "Zone 1 - Centro", // same as stored, must not appear in the audit
      description: "Along the highway",
    });

    const audit = await auditFor("collection_area.update", areaId);
    expect(audit).toHaveLength(2);
    const latest = audit.find(
      (r) => (r.newValues as { description?: string } | null)?.description === "Along the highway",
    );
    expect(latest?.oldValues).toEqual({ description: "Main road side" });
    expect(latest?.newValues).toEqual({ description: "Along the highway" });
  });

  it("writes no audit row when an update changes nothing", async () => {
    const result = await updateArea(db, actorId, areaId, { name: "Zone 1 - Centro" });
    expect(result.name).toBe("Zone 1 - Centro");
    expect(await auditFor("collection_area.update", areaId)).toHaveLength(2);
  });

  it("reports NOT_FOUND for an unknown area", async () => {
    await expect(
      updateArea(db, actorId, randomUUID(), { name: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("hides inactive areas unless asked", async () => {
    await updateArea(db, actorId, areaId, { isActive: false });
    expect(await listAreas(db)).toHaveLength(0);
    expect(await listAreas(db, { includeInactive: true })).toHaveLength(1);
  });
});

describe("collectors service", () => {
  let col1Id: string;
  let col2Id: string;

  async function collectorCount() {
    return (await db.select().from(collectors)).length;
  }

  async function collectorByCode(code: string) {
    const rows = await listCollectors(db, { includeInactive: true });
    return rows.find((c) => c.code === code);
  }

  it("creates a collector without a login and writes an audit row", async () => {
    const collector = await createCollector(
      db,
      actorId,
      collectorCreateSchema.parse({ code: "col-1", fullName: "Juan Dela Cruz" }),
    );
    col1Id = collector.id;
    expect(collector.code).toBe("COL-1");
    expect(collector.userId).toBeNull();
    expect(collector.username).toBeNull();

    const audit = await auditFor("collector.create", collector.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(actorId);
  });

  it("creates a collector linked to a user and returns the username", async () => {
    const collector = await createCollector(
      db,
      actorId,
      collectorCreateSchema.parse({
        code: "col-2",
        fullName: "Maria Santos",
        contactNumber: "09170000000",
        userId: loginUserId,
      }),
    );
    col2Id = collector.id;
    expect(collector.userId).toBe(loginUserId);
    expect(collector.username).toBe("collector_login");
    expect(collector.contactNumber).toBe("09170000000");
  });

  it("rejects a duplicate collector code", async () => {
    await expect(
      createCollector(
        db,
        actorId,
        collectorCreateSchema.parse({ code: "col-1", fullName: "Someone Else" }),
      ),
    ).rejects.toMatchObject({ code: "CODE_TAKEN", status: 409 });
  });

  it("rejects linking a user who already belongs to another collector", async () => {
    await expect(
      createCollector(
        db,
        actorId,
        collectorCreateSchema.parse({ code: "col-3", fullName: "Third", userId: loginUserId }),
      ),
    ).rejects.toMatchObject({ code: "USER_ALREADY_LINKED", status: 409 });
  });

  it("rejects an unknown user id and leaves no collector behind", async () => {
    await expect(
      createCollector(
        db,
        actorId,
        collectorCreateSchema.parse({ code: "col-4", fullName: "Fourth", userId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND", status: 422 });

    // Only COL-1 and COL-2 exist after all the failed attempts above.
    expect(await collectorCount()).toBe(2);
  });

  it("unlinks a login with null and audits the old and new user ids", async () => {
    const updated = await updateCollector(db, actorId, col2Id, {
      userId: null,
      reason: "left company",
    });
    expect(updated.userId).toBeNull();
    expect(updated.username).toBeNull();

    const audit = await auditFor("collector.update", col2Id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("left company");
    expect(audit[0]?.oldValues).toEqual({ userId: loginUserId });
    expect(audit[0]?.newValues).toEqual({ userId: null });
  });

  it("lets a freed user be linked to a different collector", async () => {
    const updated = await updateCollector(db, actorId, col1Id, { userId: loginUserId });
    expect(updated.userId).toBe(loginUserId);
    expect(updated.username).toBe("collector_login");

    const audit = await auditFor("collector.update", col1Id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.oldValues).toEqual({ userId: null });
    expect(audit[0]?.newValues).toEqual({ userId: loginUserId });
  });

  it("rejects linking a user held by another collector and rolls everything back", async () => {
    await expect(
      updateCollector(db, actorId, col2Id, { userId: loginUserId }),
    ).rejects.toMatchObject({ code: "USER_ALREADY_LINKED", status: 409 });

    expect((await collectorByCode("COL-2"))?.userId).toBeNull();
    // Only the unlink from the earlier test is audited for COL-2.
    expect(await auditFor("collector.update", col2Id)).toHaveLength(1);
  });

  it("writes no audit row when an update changes nothing", async () => {
    await updateCollector(db, actorId, col1Id, { fullName: "Juan Dela Cruz" });
    expect(await auditFor("collector.update", col1Id)).toHaveLength(1);
  });

  it("reports NOT_FOUND for an unknown collector", async () => {
    await expect(
      updateCollector(db, actorId, randomUUID(), { fullName: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("hides inactive collectors unless asked", async () => {
    await updateCollector(db, actorId, col2Id, { isActive: false });

    const active = await listCollectors(db);
    expect(active.map((c) => c.code)).toEqual(["COL-1"]);
    expect(await listCollectors(db, { includeInactive: true })).toHaveLength(2);
  });
});