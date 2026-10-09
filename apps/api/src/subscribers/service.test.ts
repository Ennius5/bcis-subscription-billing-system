import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  areaCreateSchema,
  collectorCreateSchema,
  subscriberAssignmentSchema,
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
import {
  changeSubscriberAssignment,
  changeSubscriberStatus,
  createSubscriber,
  listSubscribers,
  updateSubscriber,
} from "./service";

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

describe("updateSubscriber", () => {
  let subscriberId: string;

  beforeAll(async () => {
    subscriberId = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Update Test" }))).id;
  });

  it("updates fields and audits only what changed, with the reason", async () => {
    const updated = await updateSubscriber(db, actorId, subscriberId, {
      fullName: "Updated Name",
      billingDay: 5, // same as stored, must not appear in the audit
      reason: "Name correction",
    });
    expect(updated.fullName).toBe("Updated Name");

    const audit = await auditFor("subscriber.update", subscriberId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("Name correction");
    expect(audit[0]?.oldValues).toEqual({ fullName: "Update Test" });
    expect(audit[0]?.newValues).toEqual({ fullName: "Updated Name" });
  });

  it("writes no audit row when an update changes nothing", async () => {
    const result = await updateSubscriber(db, actorId, subscriberId, { fullName: "Updated Name" });
    expect(result.fullName).toBe("Updated Name");
    expect(await auditFor("subscriber.update", subscriberId)).toHaveLength(1);
  });

  it("sets and then clears the notes", async () => {
    const withNotes = await updateSubscriber(db, actorId, subscriberId, {
      notes: "Prefers evening collection",
    });
    expect(withNotes.notes).toBe("Prefers evening collection");

    const cleared = await updateSubscriber(db, actorId, subscriberId, { notes: null });
    expect(cleared.notes).toBeNull();
    expect(await auditFor("subscriber.update", subscriberId)).toHaveLength(3);
  });

  it("allows edits on a terminated subscriber but not on an archived one", async () => {
    const id = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Closing Account" }))).id;
    await changeSubscriberStatus(
      db,
      actorId,
      id,
      subscriberStatusChangeSchema.parse({ status: "terminated", reason: "Contract ended" }),
    );
    const edited = await updateSubscriber(db, actorId, id, { notes: "Final reading done" });
    expect(edited.notes).toBe("Final reading done");

    await changeSubscriberStatus(
      db,
      actorId,
      id,
      subscriberStatusChangeSchema.parse({ status: "archived", reason: "Account closed out" }),
    );
    await expect(updateSubscriber(db, actorId, id, { notes: "Too late" })).rejects.toMatchObject({
      code: "SUBSCRIBER_ARCHIVED",
      status: 409,
    });
  });

  it("reports NOT_FOUND for an unknown subscriber", async () => {
    await expect(
      updateSubscriber(db, actorId, randomUUID(), { fullName: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("changeSubscriberAssignment", () => {
  let subscriberId: string;
  let area2Id: string;
  let collector2Id: string;

  beforeAll(async () => {
    subscriberId = (
      await createSubscriber(
        db,
        actorId,
        newSubscriber({
          fullName: "Route Test",
          collectionAreaId: areaId,
          assignedCollectorId: collectorId,
        }),
      )
    ).id;
    area2Id = (await createArea(db, actorId, areaCreateSchema.parse({ code: "zone-2", name: "Zone 2" }))).id;
    collector2Id = (
      await createCollector(db, actorId, collectorCreateSchema.parse({ code: "col-2", fullName: "Maria Collector" }))
    ).id;
  });

  const assign = (
    collectionAreaId: string | null,
    assignedCollectorId: string | null,
    reason?: string,
    id = subscriberId,
  ) =>
    changeSubscriberAssignment(
      db,
      actorId,
      id,
      subscriberAssignmentSchema.parse({ collectionAreaId, assignedCollectorId, reason }),
    );

  const history = (id = subscriberId) =>
    db
      .select()
      .from(collectorAssignments)
      .where(eq(collectorAssignments.subscriberId, id))
      .orderBy(asc(collectorAssignments.effectiveFrom));

  it("closes the open period, opens a new one and audits old and new with the reason", async () => {
    const updated = await assign(area2Id, collector2Id, "Route rebalancing");
    expect(updated.areaCode).toBe("ZONE-2");
    expect(updated.collectorCode).toBe("COL-2");

    const rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.effectiveTo).not.toBeNull();
    expect(rows[1]).toMatchObject({
      collectionAreaId: area2Id,
      collectorId: collector2Id,
      effectiveTo: null,
      assignedByUserId: actorId,
      reason: "Route rebalancing",
    });
    // The closed period ends exactly where the new one starts.
    expect(rows[0]?.effectiveTo?.getTime()).toBe(rows[1]?.effectiveFrom.getTime());

    const audit = await auditFor("subscriber.assignment_change", subscriberId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("Route rebalancing");
    expect(audit[0]?.oldValues).toEqual({ collectionAreaId: areaId, assignedCollectorId: collectorId });
    expect(audit[0]?.newValues).toEqual({ collectionAreaId: area2Id, assignedCollectorId: collector2Id });
  });

  it("writes nothing when the assignment is unchanged", async () => {
    await assign(area2Id, collector2Id);
    expect(await history()).toHaveLength(2);
    expect(await auditFor("subscriber.assignment_change", subscriberId)).toHaveLength(1);
  });

  it("changes only the collector and keeps the area", async () => {
    const updated = await assign(area2Id, collectorId);
    expect(updated.collectionAreaId).toBe(area2Id);
    expect(updated.collectorCode).toBe("COL-1");
    expect(await history()).toHaveLength(3);
  });

  it("clearing both only closes the open period", async () => {
    const updated = await assign(null, null, "Moved out of coverage");
    expect(updated.collectionAreaId).toBeNull();
    expect(updated.assignedCollectorId).toBeNull();

    const rows = await history();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.effectiveTo !== null)).toBe(true);
    expect(await auditFor("subscriber.assignment_change", subscriberId)).toHaveLength(3);
  });

  it("assigns an unassigned subscriber without anything to close", async () => {
    const id = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Fresh Route" }))).id;
    await assign(areaId, null, undefined, id);
    const rows = await history(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ collectionAreaId: areaId, collectorId: null, effectiveTo: null });
  });

  it("rejects an inactive collector and leaves the assignment untouched", async () => {
    const collector = await createCollector(
      db,
      actorId,
      collectorCreateSchema.parse({ code: "col-gone", fullName: "Former Collector" }),
    );
    await updateCollector(db, actorId, collector.id, { isActive: false });
    await expect(assign(areaId, collector.id)).rejects.toMatchObject({
      code: "COLLECTOR_INACTIVE",
      status: 422,
    });
    expect(await history()).toHaveLength(3);
    expect(await auditFor("subscriber.assignment_change", subscriberId)).toHaveLength(3);
  });

  it("rejects an unknown area", async () => {
    await expect(assign(randomUUID(), null)).rejects.toMatchObject({ code: "AREA_NOT_FOUND" });
  });

  it("rejects reassigning an archived subscriber", async () => {
    const id = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Archived Route" }))).id;
    for (const status of ["terminated", "archived"]) {
      await changeSubscriberStatus(
        db,
        actorId,
        id,
        subscriberStatusChangeSchema.parse({ status, reason: "Closing account" }),
      );
    }
    await expect(assign(areaId, null, undefined, id)).rejects.toMatchObject({
      code: "SUBSCRIBER_ARCHIVED",
      status: 409,
    });
  });

  it("reports NOT_FOUND for an unknown subscriber", async () => {
    await expect(assign(areaId, null, undefined, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});