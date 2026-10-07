import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  areaCreateSchema,
  collectorCreateSchema,
  subscriberCreateSchema,
  subscriberListQuerySchema,
  subscriberStatusChangeSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createArea,
  createCollector,
  updateArea,
  updateCollector,
} from "../collection/service";
import { auditLogs, collectorAssignments, subscribers } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import { changeSubscriberStatus, createSubscriber, listSubscribers } from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let areaId: string;
let collectorId: string;

function newSubscriber(overrides: Record<string, unknown> = {}) {
  return subscriberCreateSchema.parse({
    fullName: "Pedro Penduko",
    billingDay: 5,
    address: { line1: "Purok 1", barangay: "Poblacion", city: "Maramag", province: "Bukidnon" },
    ...overrides,
  });
}

async function auditFor(action: string, entityId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

async function subscriberCount() {
  return (await db.select().from(subscribers)).length;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "subscriber_actor", "Passw0rd!test", "administrator");
  areaId = (await createArea(db, actorId, areaCreateSchema.parse({ code: "zone-1", name: "Zone 1" }))).id;
  collectorId = (
    await createCollector(db, actorId, collectorCreateSchema.parse({ code: "col-1", fullName: "Juan Collector" }))
  ).id;
});

afterAll(async () => {
  await pool.end();
});

describe("createSubscriber", () => {
  it("creates the subscriber, primary address, contacts and first assignment", async () => {
    const created = await createSubscriber(
      db,
      actorId,
      newSubscriber({
        collectionAreaId: areaId,
        assignedCollectorId: collectorId,
        notes: "Demo account",
        contacts: [
          { type: "mobile", value: "09171234567", isPrimary: true },
          { type: "email", value: "pedro@example.com" },
        ],
      }),
    );

    expect(created.accountNumber).toMatch(/^BCIS-\d{6}$/);
    expect(created.status).toBe("active");
    expect(created.areaCode).toBe("ZONE-1");
    expect(created.collectorCode).toBe("COL-1");
    expect(created.addresses).toHaveLength(1);
    expect(created.addresses[0]?.isPrimary).toBe(true);
    expect(created.contacts).toHaveLength(2);
    expect(created.contacts[0]?.isPrimary).toBe(true);

    const assignments = await db
      .select()
      .from(collectorAssignments)
      .where(eq(collectorAssignments.subscriberId, created.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.effectiveTo).toBeNull();
    expect(assignments[0]?.assignedByUserId).toBe(actorId);

    const audit = await auditFor("subscriber.create", created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(actorId);
  });

  it("writes no assignment row when no area or collector is given", async () => {
    const created = await createSubscriber(db, actorId, newSubscriber({ fullName: "No Route" }));
    expect(created.collectionAreaId).toBeNull();
    expect(created.assignedCollectorId).toBeNull();
    expect(created.contacts).toHaveLength(0);

    const assignments = await db
      .select()
      .from(collectorAssignments)
      .where(eq(collectorAssignments.subscriberId, created.id));
    expect(assignments).toHaveLength(0);
  });

  it("rejects an unknown area and leaves nothing behind", async () => {
    const before = await subscriberCount();
    await expect(
      createSubscriber(db, actorId, newSubscriber({ collectionAreaId: randomUUID() })),
    ).rejects.toMatchObject({ code: "AREA_NOT_FOUND", status: 422 });
    expect(await subscriberCount()).toBe(before);
  });

  it("rejects an unknown collector", async () => {
    await expect(
      createSubscriber(db, actorId, newSubscriber({ assignedCollectorId: randomUUID() })),
    ).rejects.toMatchObject({ code: "COLLECTOR_NOT_FOUND", status: 422 });
  });

  it("rejects an inactive area", async () => {
    const area = await createArea(db, actorId, areaCreateSchema.parse({ code: "zone-old", name: "Old Zone" }));
    await updateArea(db, actorId, area.id, { isActive: false });
    await expect(
      createSubscriber(db, actorId, newSubscriber({ collectionAreaId: area.id })),
    ).rejects.toMatchObject({ code: "AREA_INACTIVE", status: 422 });
  });

  it("rejects an inactive collector", async () => {
    const collector = await createCollector(
      db,
      actorId,
      collectorCreateSchema.parse({ code: "col-old", fullName: "Retired Collector" }),
    );
    await updateCollector(db, actorId, collector.id, { isActive: false });
    await expect(
      createSubscriber(db, actorId, newSubscriber({ assignedCollectorId: collector.id })),
    ).rejects.toMatchObject({ code: "COLLECTOR_INACTIVE", status: 422 });
  });
});

describe("listSubscribers", () => {
  let anaAccount: string;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE subscribers CASCADE`);
    const ana = await createSubscriber(
      db,
      actorId,
      newSubscriber({
        fullName: "Ana Reyes",
        collectionAreaId: areaId,
        assignedCollectorId: collectorId,
        contacts: [{ type: "mobile", value: "09170000001", isPrimary: true }],
      }),
    );
    anaAccount = ana.accountNumber;
    const ben = await createSubscriber(db, actorId, newSubscriber({ fullName: "Ben Reyes" }));
    await createSubscriber(db, actorId, newSubscriber({ fullName: "Carla 100% Cruz" }));
    await db.update(subscribers).set({ status: "archived" }).where(eq(subscribers.id, ben.id));
  });

  const names = (page: Awaited<ReturnType<typeof listSubscribers>>) =>
    page.items.map((s) => s.fullName);

  it("hides archived subscribers by default, ordered by account number", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({}));
    expect(page.total).toBe(2);
    expect(names(page)).toEqual(["Ana Reyes", "Carla 100% Cruz"]);
  });

  it("shows archived subscribers when the Archived filter is chosen", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({ status: "archived" }));
    expect(names(page)).toEqual(["Ben Reyes"]);
  });

  it("paginates and reports the total", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({ page: "2", pageSize: "1" }));
    expect(page.total).toBe(2);
    expect(page.page).toBe(2);
    expect(names(page)).toEqual(["Carla 100% Cruz"]);
  });

  it("filters by area and returns the area and primary contact", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({ collectionAreaId: areaId }));
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      fullName: "Ana Reyes",
      areaCode: "ZONE-1",
      collectorCode: "COL-1",
      primaryContact: "09170000001",
    });
  });

  it("searches names case-insensitively", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({ search: "reyes" }));
    expect(names(page)).toEqual(["Ana Reyes"]); // Ben is archived
  });

  it("searches by account number", async () => {
    const page = await listSubscribers(db, subscriberListQuerySchema.parse({ search: anaAccount }));
    expect(names(page)).toEqual(["Ana Reyes"]);
  });

  it("treats % and _ in the search literally", async () => {
    const percent = await listSubscribers(db, subscriberListQuerySchema.parse({ search: "%" }));
    expect(names(percent)).toEqual(["Carla 100% Cruz"]);
    const underscore = await listSubscribers(db, subscriberListQuerySchema.parse({ search: "_" }));
    expect(underscore.total).toBe(0);
  });
});

describe("changeSubscriberStatus", () => {
  let subscriberId: string;

  beforeAll(async () => {
    subscriberId = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Status Test" }))).id;
  });

  const change = (status: string, reason = "Customer request") =>
    changeSubscriberStatus(
      db,
      actorId,
      subscriberId,
      subscriberStatusChangeSchema.parse({ status, reason }),
    );

  it("moves active to inactive and audits the old and new status with the reason", async () => {
    const updated = await change("inactive", "Moved away temporarily");
    expect(updated.status).toBe("inactive");

    const audit = await auditFor("subscriber.status_change", subscriberId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("Moved away temporarily");
    expect(audit[0]?.oldValues).toEqual({ status: "active" });
    expect(audit[0]?.newValues).toEqual({ status: "inactive" });
  });

  it("rejects a transition the rules do not allow", async () => {
    await expect(change("archived")).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
      status: 409,
    });
    expect(await auditFor("subscriber.status_change", subscriberId)).toHaveLength(1);
  });

  it("rejects changing to the current status", async () => {
    await expect(change("inactive")).rejects.toMatchObject({ code: "INVALID_STATUS_CHANGE" });
  });

  it("follows inactive to terminated to archived, then stays final", async () => {
    expect((await change("terminated")).status).toBe("terminated");
    expect((await change("archived")).status).toBe("archived");
    await expect(change("active")).rejects.toMatchObject({ code: "INVALID_STATUS_CHANGE" });
    expect(await auditFor("subscriber.status_change", subscriberId)).toHaveLength(3);
  });

  it("reports NOT_FOUND for an unknown subscriber", async () => {
    await expect(
      changeSubscriberStatus(
        db,
        actorId,
        randomUUID(),
        subscriberStatusChangeSchema.parse({ status: "inactive", reason: "No such account" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});