import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  addressCreateSchema,
  collectorCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceAccountListQuerySchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
  subscriberStatusChangeSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCollector, updateCollector } from "../collection/service";
import { auditLogs } from "../db/schema";
import { createPlan, updatePlan } from "../plans/service";
import {
  addSubscriberAddress,
  changeSubscriberStatus,
  createSubscriber,
  updateSubscriberAddress,
} from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import {
  changeServiceCollector,
  changeServicePlan,
  changeServiceRate,
  changeServiceStatus,
  createServiceAccount,
  getServiceAccount,
  listServiceAccounts,
  updateServiceAccount,
} from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let internetPlanId: string;
let cablePlanId: string;
let collectorId: string;

async function newSubscriber(fullName: string, billingDay = 7) {
  return createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName,
      billingDay,
      address: { line1: "Purok 2", barangay: "Poblacion", city: "Maramag" },
    }),
  );
}

async function newAccount(subscriber: { id: string; addresses: { id: string }[] }, overrides = {}) {
  return createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({
      planId: internetPlanId,
      installationAddressId: subscriber.addresses[0]!.id,
      ...overrides,
    }),
  );
}

const status = (to: string, extra: Record<string, unknown> = {}) =>
  serviceStatusChangeSchema.parse({ status: to, reason: "Field work", ...extra });

async function auditFor(action: string, entityId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, collection_areas, collectors CASCADE`);
  actorId = await createTestUser(db, "service_actor", "Passw0rd!test", "administrator");
  internetPlanId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({
        code: "inet-25",
        name: "Internet 25 Mbps",
        serviceType: "internet",
        priceCentavos: 99900,
        speedMbps: 25,
      }),
    )
  ).id;
  cablePlanId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({
        code: "cable-basic",
        name: "Cable Basic",
        serviceType: "cable",
        priceCentavos: 45000,
        channelCount: 60,
      }),
    )
  ).id;
  collectorId = (
    await createCollector(db, actorId, collectorCreateSchema.parse({ code: "col-1", fullName: "Juan Collector" }))
  ).id;
});

afterAll(async () => {
  await pool.end();
});

describe("createServiceAccount", () => {
  it("creates a pending account with the plan's price as its rate and the subscriber's billing day", async () => {
    const subscriber = await newSubscriber("Ana Service", 12);
    const account = await newAccount(subscriber);

    expect(account.serviceNumber).toMatch(/^SVC-\d{6}$/);
    expect(account.status).toBe("pending");
    expect(account.currentRateCentavos).toBe(99900);
    expect(account.billingDay).toBe(12);
    expect(account.activationDate).toBeNull();
    expect(account.serviceType).toBe("internet");
    expect(account.events).toHaveLength(1);
    expect(account.events[0]).toMatchObject({ eventType: "created", toStatus: "pending" });
    expect(await auditFor("service_account.create", account.id)).toHaveLength(1);
  });

  it("keeps the account's rate when the plan price later changes", async () => {
    const subscriber = await newSubscriber("Rate Snapshot");
    const account = await newAccount(subscriber, { planId: cablePlanId });
    await updatePlan(db, actorId, cablePlanId, { priceCentavos: 50000 });

    expect((await getServiceAccount(db, account.id)).currentRateCentavos).toBe(45000);
    // New accounts get the new price.
    expect((await newAccount(subscriber, { planId: cablePlanId })).currentRateCentavos).toBe(50000);
  });

  it("allows an inactive subscriber but refuses terminated and archived ones", async () => {
    const subscriber = await newSubscriber("Paused Customer");
    await changeSubscriberStatus(db, actorId, subscriber.id, subscriberStatusChangeSchema.parse({ status: "inactive", reason: "Away" }));
    expect((await newAccount(subscriber)).status).toBe("pending");

    await changeSubscriberStatus(db, actorId, subscriber.id, subscriberStatusChangeSchema.parse({ status: "terminated", reason: "Left" }));
    await expect(newAccount(subscriber)).rejects.toMatchObject({ code: "SUBSCRIBER_CLOSED", status: 409 });
  });

  it("refuses an address belonging to another subscriber", async () => {
    const subscriber = await newSubscriber("Owner");
    const other = await newSubscriber("Someone Else");
    await expect(
      newAccount(subscriber, { installationAddressId: other.addresses[0]!.id }),
    ).rejects.toMatchObject({ code: "ADDRESS_NOT_FOUND", status: 422 });
  });

  it("refuses an inactive plan", async () => {
    const subscriber = await newSubscriber("Old Plan");
    const plan = await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-old", name: "Old", serviceType: "internet", priceCentavos: 1, speedMbps: 1 }),
    );
    await updatePlan(db, actorId, plan.id, { isActive: false });
    await expect(newAccount(subscriber, { planId: plan.id })).rejects.toMatchObject({ code: "PLAN_INACTIVE" });
  });

  it("refuses an unknown subscriber", async () => {
    await expect(
      createServiceAccount(db, actorId, randomUUID(), { planId: internetPlanId, installationAddressId: randomUUID() }),
    ).rejects.toMatchObject({ code: "SUBSCRIBER_NOT_FOUND", status: 404 });
  });
});

describe("the database itself", () => {
  it("rejects an installation address from another subscriber even without the service", async () => {
    const subscriber = await newSubscriber("FK Owner");
    const other = await newSubscriber("FK Other");
    const account = await newAccount(subscriber);
    await expect(
      db.execute(
        sql`UPDATE service_accounts SET installation_address_id = ${other.addresses[0]!.id} WHERE id = ${account.id}`,
      ),
    ).rejects.toThrow();
  });

  it("keeps service history append-only", async () => {
    const account = await newAccount(await newSubscriber("History Lock"));
    // Raw pool queries, so the trigger's own message is what gets thrown (as in audit.test.ts).
    await expect(
      pool.query("UPDATE service_events SET reason = 'edited' WHERE service_account_id = $1", [account.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM service_events WHERE service_account_id = $1", [account.id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("changeServiceStatus", () => {
  it("activation sets the activation date and defaults billing start to it", async () => {
    const account = await newAccount(await newSubscriber("Activate Me"));
    const active = await changeServiceStatus(db, actorId, account.id, status("active", { effectiveDate: "2026-10-01" }));
    expect(active).toMatchObject({ status: "active", activationDate: "2026-10-01", billingStartDate: "2026-10-01" });
    expect(active.events[0]).toMatchObject({
      eventType: "status_change",
      fromStatus: "pending",
      toStatus: "active",
      effectiveDate: "2026-10-01",
      reason: "Field work",
    });
  });

  it("activation accepts a later billing start date", async () => {
    const account = await newAccount(await newSubscriber("Later Billing"));
    const active = await changeServiceStatus(
      db,
      actorId,
      account.id,
      status("active", { effectiveDate: "2026-10-05", billingStartDate: "2026-11-01" }),
    );
    expect(active.billingStartDate).toBe("2026-11-01");
  });

  it("defaults the effective date to today by the database clock", async () => {
    const account = await newAccount(await newSubscriber("Today"));
    const active = await changeServiceStatus(db, actorId, account.id, status("active"));
    const result = await db.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`);
    expect(active.activationDate).toBe(result.rows[0]?.today);
  });

  it("leaves suspending and reconnecting to their own actions (Phase 7)", async () => {
    const account = await newAccount(await newSubscriber("Suspend Me"));
    await changeServiceStatus(db, actorId, account.id, status("active", { effectiveDate: "2026-09-01" }));
    await expect(changeServiceStatus(db, actorId, account.id, status("suspended"))).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
      status: 409,
    });
  });

  it("refuses transitions the rules do not allow, and terminated is final and read-only", async () => {
    const account = await newAccount(await newSubscriber("Rules"));
    await expect(changeServiceStatus(db, actorId, account.id, status("suspended"))).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
      status: 409,
    });

    // Cancelled before installation: no activation date, which the DB allows for terminated.
    const cancelled = await changeServiceStatus(db, actorId, account.id, status("terminated"));
    expect(cancelled.activationDate).toBeNull();
    await expect(changeServiceStatus(db, actorId, account.id, status("active"))).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
    });
    await expect(
      updateServiceAccount(db, actorId, account.id, { notes: "late edit" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_TERMINATED", status: 409 });
  });

  it("only allows terminating the services of a terminated subscriber", async () => {
    const subscriber = await newSubscriber("Closing Down");
    const account = await newAccount(subscriber);
    await changeSubscriberStatus(db, actorId, subscriber.id, subscriberStatusChangeSchema.parse({ status: "terminated", reason: "Left" }));
    await expect(changeServiceStatus(db, actorId, account.id, status("active"))).rejects.toMatchObject({
      code: "SUBSCRIBER_CLOSED",
    });
    expect((await changeServiceStatus(db, actorId, account.id, status("terminated"))).status).toBe("terminated");
  });
});

describe("rate, plan and collector changes", () => {
  it("rate change records old and new rate with the reason; same rate writes nothing", async () => {
    const account = await newAccount(await newSubscriber("Discounted"));
    const updated = await changeServiceRate(db, actorId, account.id, {
      rateCentavos: 79900,
      reason: "Senior discount",
      effectiveDate: "2026-11-01",
    });
    expect(updated.currentRateCentavos).toBe(79900);
    expect(updated.events[0]).toMatchObject({
      eventType: "rate_change",
      oldValues: { rateCentavos: 99900 },
      newValues: { rateCentavos: 79900 },
      effectiveDate: "2026-11-01",
    });

    await changeServiceRate(db, actorId, account.id, { rateCentavos: 79900, reason: "Again" });
    expect(await auditFor("service_account.rate_change", account.id)).toHaveLength(1);
  });

  it("plan change takes the new plan's price unless a rate is given", async () => {
    const account = await newAccount(await newSubscriber("Switcher"));
    const switched = await changeServicePlan(db, actorId, account.id, { planId: cablePlanId, reason: "Wants cable" });
    expect(switched.planId).toBe(cablePlanId);
    expect(switched.serviceType).toBe("cable");
    expect(switched.events[0]).toMatchObject({
      eventType: "plan_change",
      oldValues: { planId: internetPlanId, rateCentavos: 99900 },
    });

    await expect(
      changeServicePlan(db, actorId, account.id, { planId: cablePlanId, reason: "Again" }),
    ).rejects.toMatchObject({ code: "SAME_PLAN", status: 409 });

    const custom = await changeServicePlan(db, actorId, account.id, {
      planId: internetPlanId,
      rateCentavos: 89900,
      reason: "Back with promo",
    });
    expect(custom.currentRateCentavos).toBe(89900);
  });

  it("the collector override wins, and clearing it falls back to the subscriber's", async () => {
    const subscriber = await newSubscriber("Collector Test");
    const account = await newAccount(subscriber);
    expect(account.collectorCode).toBeNull(); // subscriber has no collector either

    const overridden = await changeServiceCollector(db, actorId, account.id, { assignedCollectorId: collectorId });
    expect(overridden.collectorCode).toBe("COL-1");

    const cleared = await changeServiceCollector(db, actorId, account.id, { assignedCollectorId: null });
    expect(cleared.assignedCollectorId).toBeNull();
    expect(await auditFor("service_account.collector_change", account.id)).toHaveLength(2);
  });

  it("refuses an inactive collector", async () => {
    const account = await newAccount(await newSubscriber("Bad Collector"));
    const collector = await createCollector(db, actorId, collectorCreateSchema.parse({ code: "col-x", fullName: "Gone" }));
    await updateCollector(db, actorId, collector.id, { isActive: false });
    await expect(
      changeServiceCollector(db, actorId, account.id, { assignedCollectorId: collector.id }),
    ).rejects.toMatchObject({ code: "COLLECTOR_INACTIVE" });
  });
});

describe("updateServiceAccount", () => {
  it("moves the installation address and audits only what changed", async () => {
    const subscriber = await newSubscriber("Mover");
    const account = await newAccount(subscriber);
    const withShop = await addSubscriberAddress(
      db,
      actorId,
      subscriber.id,
      addressCreateSchema.parse({ line1: "Shop", barangay: "Dologon", city: "Maramag" }),
    );
    const shopId = withShop.addresses.find((a) => a.line1 === "Shop")!.id;

    const moved = await updateServiceAccount(db, actorId, account.id, {
      installationAddressId: shopId,
      billingDay: account.billingDay, // unchanged
      reason: "Relocated",
    });
    expect(moved.addressLine1).toBe("Shop");
    expect(moved.events[0]).toMatchObject({
      eventType: "update",
      newValues: { installationAddressId: shopId },
      reason: "Relocated",
    });

    await updateServiceAccount(db, actorId, account.id, { installationAddressId: shopId });
    expect(await auditFor("service_account.update", account.id)).toHaveLength(1);
  });

  it("blocks deactivating an address a live service is installed at", async () => {
    const subscriber = await newSubscriber("Installed Here");
    const withSecond = await addSubscriberAddress(
      db,
      actorId,
      subscriber.id,
      addressCreateSchema.parse({ line1: "Second", barangay: "Dologon", city: "Maramag" }),
    );
    const secondId = withSecond.addresses.find((a) => a.line1 === "Second")!.id;
    await newAccount(subscriber, { installationAddressId: secondId });

    await expect(
      updateSubscriberAddress(db, actorId, subscriber.id, secondId, { isActive: false }),
    ).rejects.toMatchObject({ code: "ADDRESS_IN_USE", status: 409 });
  });
});

describe("listServiceAccounts", () => {
  it("filters by subscriber, status and service type, and searches", async () => {
    const subscriber = await newSubscriber("Listed Person");
    const internet = await newAccount(subscriber);
    await newAccount(subscriber, { planId: cablePlanId });
    await changeServiceStatus(db, actorId, internet.id, status("active"));

    const mine = await listServiceAccounts(db, serviceAccountListQuerySchema.parse({ subscriberId: subscriber.id }));
    expect(mine.total).toBe(2);

    const active = await listServiceAccounts(
      db,
      serviceAccountListQuerySchema.parse({ subscriberId: subscriber.id, status: "active" }),
    );
    expect(active.items.map((a) => a.id)).toEqual([internet.id]);

    const cable = await listServiceAccounts(
      db,
      serviceAccountListQuerySchema.parse({ subscriberId: subscriber.id, serviceType: "cable" }),
    );
    expect(cable.total).toBe(1);

    const byName = await listServiceAccounts(db, serviceAccountListQuerySchema.parse({ search: "listed per" }));
    expect(byName.total).toBe(2);
    const byNumber = await listServiceAccounts(db, serviceAccountListQuerySchema.parse({ search: internet.serviceNumber }));
    expect(byNumber.items[0]?.id).toBe(internet.id);
  });
});
