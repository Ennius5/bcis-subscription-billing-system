import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  addressCreateSchema,
  areaCreateSchema,
  collectorCreateSchema,
  contactInputSchema,
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
  addSubscriberAddress,
  addSubscriberContact,
  changeSubscriberAssignment,
  changeSubscriberStatus,
  createSubscriber,
  listSubscribers,
  updateSubscriber,
  updateSubscriberAddress,
  updateSubscriberContact,
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

describe("addresses", () => {
  let subscriberId: string;
  let firstAddressId: string;

  beforeAll(async () => {
    const created = await createSubscriber(db, actorId, newSubscriber({ fullName: "Address Test" }));
    subscriberId = created.id;
    firstAddressId = created.addresses[0]!.id;
  });

  const address = (overrides: Record<string, unknown> = {}) =>
    addressCreateSchema.parse({ line1: "Purok 7", barangay: "Dologon", city: "Maramag", ...overrides });

  it("adds a secondary address and audits it against the subscriber", async () => {
    const updated = await addSubscriberAddress(db, actorId, subscriberId, address({ label: "Shop" }));
    expect(updated.addresses).toHaveLength(2);
    expect(updated.addresses[0]?.id).toBe(firstAddressId); // primary listed first
    expect(updated.addresses[1]).toMatchObject({ label: "Shop", isPrimary: false, isActive: true });

    const audit = await auditFor("subscriber.address_add", subscriberId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.newValues).toMatchObject({ addressId: updated.addresses[1]?.id, label: "Shop" });
  });

  it("adding a primary address demotes the old primary", async () => {
    const updated = await addSubscriberAddress(db, actorId, subscriberId, address({ isPrimary: true }));
    const primaries = updated.addresses.filter((a) => a.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).not.toBe(firstAddressId);

    const audit = await auditFor("subscriber.address_add", subscriberId);
    expect(audit.map((a) => a.newValues)).toContainEqual(
      expect.objectContaining({ demotedAddressId: firstAddressId }),
    );
  });

  it("promotes an address back to primary and records the demoted one", async () => {
    const before = await addSubscriberAddress(db, actorId, subscriberId, address({ line1: "Purok 9" }));
    const currentPrimary = before.addresses.find((a) => a.isPrimary)!.id;

    const updated = await updateSubscriberAddress(db, actorId, subscriberId, firstAddressId, {
      isPrimary: true,
      reason: "Back to original house",
    });
    expect(updated.addresses[0]?.id).toBe(firstAddressId);
    expect(updated.addresses.filter((a) => a.isPrimary)).toHaveLength(1);

    const audit = await auditFor("subscriber.address_update", subscriberId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("Back to original house");
    expect(audit[0]?.oldValues).toEqual({ addressId: firstAddressId, isPrimary: false });
    expect(audit[0]?.newValues).toEqual({
      addressId: firstAddressId,
      isPrimary: true,
      demotedAddressId: currentPrimary,
    });
  });

  it("edits fields, audits only what changed and skips a no-op", async () => {
    await updateSubscriberAddress(db, actorId, subscriberId, firstAddressId, {
      landmark: "Near the chapel",
      city: "Maramag", // unchanged
    });
    let audit = await auditFor("subscriber.address_update", subscriberId);
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.newValues)).toContainEqual({
      addressId: firstAddressId,
      landmark: "Near the chapel",
    });

    await updateSubscriberAddress(db, actorId, subscriberId, firstAddressId, { landmark: "Near the chapel" });
    audit = await auditFor("subscriber.address_update", subscriberId);
    expect(audit).toHaveLength(2);
  });

  it("blocks deactivating the primary address", async () => {
    await expect(
      updateSubscriberAddress(db, actorId, subscriberId, firstAddressId, { isActive: false }),
    ).rejects.toMatchObject({ code: "PRIMARY_CANNOT_DEACTIVATE", status: 409 });
  });

  it("deactivates a secondary address but will not make it primary while inactive", async () => {
    const detail = await addSubscriberAddress(db, actorId, subscriberId, address({ label: "Old shop" }));
    const oldShop = detail.addresses.find((a) => a.label === "Old shop")!.id;

    const updated = await updateSubscriberAddress(db, actorId, subscriberId, oldShop, { isActive: false });
    expect(updated.addresses.find((a) => a.id === oldShop)?.isActive).toBe(false);

    await expect(
      updateSubscriberAddress(db, actorId, subscriberId, oldShop, { isPrimary: true }),
    ).rejects.toMatchObject({ code: "INACTIVE_CANNOT_BE_PRIMARY", status: 409 });

    // Reactivating and promoting in one request is allowed.
    const promoted = await updateSubscriberAddress(db, actorId, subscriberId, oldShop, {
      isActive: true,
      isPrimary: true,
    });
    expect(promoted.addresses[0]?.id).toBe(oldShop);
  });

  it("reports ADDRESS_NOT_FOUND for an address of another subscriber", async () => {
    const other = await createSubscriber(db, actorId, newSubscriber({ fullName: "Other Address" }));
    await expect(
      updateSubscriberAddress(db, actorId, subscriberId, other.addresses[0]!.id, { landmark: "x" }),
    ).rejects.toMatchObject({ code: "ADDRESS_NOT_FOUND", status: 404 });
  });

  it("rejects address changes on an archived subscriber", async () => {
    const id = (await createSubscriber(db, actorId, newSubscriber({ fullName: "Archived Address" }))).id;
    for (const status of ["terminated", "archived"]) {
      await changeSubscriberStatus(
        db,
        actorId,
        id,
        subscriberStatusChangeSchema.parse({ status, reason: "Closing account" }),
      );
    }
    await expect(addSubscriberAddress(db, actorId, id, address())).rejects.toMatchObject({
      code: "SUBSCRIBER_ARCHIVED",
      status: 409,
    });
  });
});

describe("contacts", () => {
  let subscriberId: string;
  let mobileId: string;

  beforeAll(async () => {
    const created = await createSubscriber(
      db,
      actorId,
      newSubscriber({
        fullName: "Contact Test",
        contacts: [{ type: "mobile", value: "09171112222", isPrimary: true }],
      }),
    );
    subscriberId = created.id;
    mobileId = created.contacts[0]!.id;
  });

  const contact = (overrides: Record<string, unknown> = {}) =>
    contactInputSchema.parse({ type: "landline", value: "088 356 1234", ...overrides });

  it("adds a contact and audits it", async () => {
    const updated = await addSubscriberContact(db, actorId, subscriberId, contact());
    expect(updated.contacts).toHaveLength(2);
    expect(updated.contacts[0]?.id).toBe(mobileId);
    expect(await auditFor("subscriber.contact_add", subscriberId)).toHaveLength(1);
  });

  it("adding a primary contact demotes the old primary", async () => {
    const updated = await addSubscriberContact(
      db,
      actorId,
      subscriberId,
      contact({ type: "email", value: "contact.test@example.com", isPrimary: true }),
    );
    expect(updated.contacts[0]?.type).toBe("email");
    expect(updated.contacts.filter((c) => c.isPrimary)).toHaveLength(1);

    // Put the mobile back as primary for the next tests.
    const restored = await updateSubscriberContact(db, actorId, subscriberId, mobileId, { isPrimary: true });
    expect(restored.contacts[0]?.id).toBe(mobileId);
  });

  it("validates an edited value against the stored type", async () => {
    await expect(
      updateSubscriberContact(db, actorId, subscriberId, mobileId, { value: "not-a-number" }),
    ).rejects.toMatchObject({ code: "INVALID_CONTACT_VALUE", status: 422 });

    const before = (await auditFor("subscriber.contact_update", subscriberId)).length;
    const updated = await updateSubscriberContact(db, actorId, subscriberId, mobileId, {
      value: "09173334444",
      reason: "New SIM",
    });
    expect(updated.contacts.find((c) => c.id === mobileId)?.value).toBe("09173334444");

    const audit = await auditFor("subscriber.contact_update", subscriberId);
    expect(audit).toHaveLength(before + 1);
    const row = audit.find((a) => a.reason === "New SIM");
    expect(row?.newValues).toEqual({ contactId: mobileId, value: "09173334444" });
  });

  it("writes no audit row on a no-op update", async () => {
    const before = (await auditFor("subscriber.contact_update", subscriberId)).length;
    await updateSubscriberContact(db, actorId, subscriberId, mobileId, { value: "09173334444" });
    expect(await auditFor("subscriber.contact_update", subscriberId)).toHaveLength(before);
  });

  it("blocks deactivating the primary contact", async () => {
    await expect(
      updateSubscriberContact(db, actorId, subscriberId, mobileId, { isActive: false }),
    ).rejects.toMatchObject({ code: "PRIMARY_CANNOT_DEACTIVATE", status: 409 });
  });

  it("allows at most 5 active contacts, and reactivating needs a free slot", async () => {
    // 3 active contacts so far; fill up to 5.
    await addSubscriberContact(db, actorId, subscriberId, contact({ value: "088 356 0004" }));
    const full = await addSubscriberContact(db, actorId, subscriberId, contact({ value: "088 356 0005" }));
    expect(full.contacts).toHaveLength(5);

    await expect(
      addSubscriberContact(db, actorId, subscriberId, contact({ value: "088 356 0006" })),
    ).rejects.toMatchObject({ code: "CONTACT_LIMIT", status: 409 });

    // Deactivating frees a slot, so a new contact fits.
    const spare = full.contacts.find((c) => c.value === "088 356 0005")!.id;
    await updateSubscriberContact(db, actorId, subscriberId, spare, { isActive: false });
    await addSubscriberContact(db, actorId, subscriberId, contact({ value: "088 356 0006" }));

    // Back at 5 active, so the deactivated one cannot come back.
    await expect(
      updateSubscriberContact(db, actorId, subscriberId, spare, { isActive: true }),
    ).rejects.toMatchObject({ code: "CONTACT_LIMIT" });
  });

  it("reports CONTACT_NOT_FOUND for an unknown contact", async () => {
    await expect(
      updateSubscriberContact(db, actorId, subscriberId, randomUUID(), { contactName: "Nobody" }),
    ).rejects.toMatchObject({ code: "CONTACT_NOT_FOUND", status: 404 });
  });
});