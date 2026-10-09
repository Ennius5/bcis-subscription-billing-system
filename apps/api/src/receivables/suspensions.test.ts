import { and, eq, sql } from "drizzle-orm";
import {
  addMonths,
  billingRunSchema,
  periodOf,
  planCreateSchema,
  reconnectionAssignSchema,
  reconnectionCancelSchema,
  reconnectionCompleteSchema,
  reconnectionRequestSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  serviceSuspendSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBillingDrafts, generateBillingDrafts } from "../billing/service";
import { dbToday } from "../db/query_helpers";
import { auditLogs, invoiceItems, invoices, reconnectionRecords, serviceAccounts, suspensionRecords } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount, getServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import {
  assignReconnection,
  cancelReconnection,
  completeReconnection,
  getServiceControlHistory,
  listTechnicians,
  requestReconnection,
  suspendService,
} from "./suspensions";

const { db, pool } = createTestDb();
let actorId: string;
let technicianId: string;
let cashierId: string;
let planId: string;
let today: string;
let invoiceNo = 0;
let subscriberNo = 0;

const RECONNECTION_FEE = 30_000;

/** A date `days` from today (negative = in the past). */
function day(days: number): string {
  const [y = 0, m = 1, d = 1] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface Service {
  id: string;
  subscriberId: string;
}

/** An active service billed from 2025, with no invoices yet. */
async function activeService(): Promise<Service> {
  subscriberNo += 1;
  const address = { line1: "Purok 5", barangay: "Poblacion", city: "Quezon" };
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({ fullName: `Control Subscriber ${subscriberNo}`, billingDay: 5, address }),
  );
  const service = await createServiceAccount(
    db,
    actorId,
    subscriber.id,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    actorId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: "2025-01-01" }),
  );
  return { id: service.id, subscriberId: subscriber.id };
}

/** A finalized, unpaid invoice due `dueInDays` from today, in its own synthetic period. */
async function openInvoice(service: Service, dueInDays: number, total = 99_900): Promise<string> {
  invoiceNo += 1;
  const year = 2000 + Math.floor((invoiceNo - 1) / 12);
  const periodStart = `${year}-${String(((invoiceNo - 1) % 12) + 1).padStart(2, "0")}-01`;
  const cycle = await pool.query<{ id: string }>(
    `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id)
     VALUES ($1::date, ($1::date + interval '1 month' - interval '1 day')::date, $2)
     ON CONFLICT (period_start) DO UPDATE SET period_start = EXCLUDED.period_start RETURNING id`,
    [periodStart, actorId],
  );
  const result = await pool.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, billing_cycle_id, subscriber_id, service_account_id, period_start, period_end,
       invoice_date, due_date, status, total_centavos, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, $6, $6, 'unpaid', $7, $8, now(), $8)
     RETURNING id`,
    [`INV-S${String(invoiceNo).padStart(5, "0")}`, cycle.rows[0]!.id, service.subscriberId, service.id, periodStart, day(dueInDays), total, actorId],
  );
  return result.rows[0]!.id;
}

/** Marks an invoice fully paid (the payment itself is not what these tests are about). */
async function settle(invoiceId: string): Promise<void> {
  await pool.query(`UPDATE invoices SET paid_centavos = total_centavos, status = 'paid' WHERE id = $1`, [invoiceId]);
}

const suspendInput = (overrides: Record<string, unknown> = {}) =>
  serviceSuspendSchema.parse({ reason: "Two months unpaid", approvedBy: "Owner", ...overrides });

/** A service suspended for one past-due invoice, which has since been paid. */
async function suspendedAndPaid(): Promise<Service> {
  const service = await activeService();
  const invoiceId = await openInvoice(service, -20);
  await suspendService(db, actorId, service.id, suspendInput());
  await settle(invoiceId);
  return service;
}

const request = (service: Service, input: Record<string, unknown> = {}) =>
  requestReconnection(db, actorId, service.id, reconnectionRequestSchema.parse(input));

async function auditCount(serviceId: string): Promise<number> {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, serviceId));
  return rows.length;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "control_actor", "Passw0rd!test", "administrator");
  technicianId = await createTestUser(db, "control_technician", "Passw0rd!test", "technician");
  cashierId = await createTestUser(db, "control_cashier", "Passw0rd!test", "cashier");
  today = await dbToday(db);
  planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({
        code: "ctl-inet",
        name: "Fiber 25",
        serviceType: "internet",
        priceCentavos: 99_900,
        reconnectionFeeCentavos: RECONNECTION_FEE,
      }),
    )
  ).id;
});

afterAll(async () => {
  await pool.end();
});

describe("suspending", () => {
  it("records the suspension with a past-due snapshot, history and audit", async () => {
    const service = await activeService();
    await openInvoice(service, -20);
    await openInvoice(service, 5); // current bill, not past due

    const detail = await suspendService(db, actorId, service.id, suspendInput({ notes: "Called twice" }));
    expect(detail.status).toBe("suspended");

    const [record] = await db.select().from(suspensionRecords).where(eq(suspensionRecords.serviceAccountId, service.id));
    expect(record).toMatchObject({
      effectiveDate: today,
      reason: "Two months unpaid",
      approvedBy: "Owner",
      notes: "Called twice",
      pastDueInvoiceCount: 1,
      pastDueCentavos: 99_900,
      suspendedByUserId: actorId,
    });
    expect(detail.events[0]).toMatchObject({ eventType: "status_change", fromStatus: "active", toStatus: "suspended" });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, service.id), eq(auditLogs.action, "service_account.suspend")));
    expect(audit?.reason).toBe("Two months unpaid");
  });

  it("only suspends active services, and not with a future date", async () => {
    const service = await activeService();
    await expect(suspendService(db, actorId, service.id, suspendInput({ effectiveDate: day(1) }))).rejects.toMatchObject({
      code: "INVALID_DATE",
    });
    await suspendService(db, actorId, service.id, suspendInput());
    await expect(suspendService(db, actorId, service.id, suspendInput())).rejects.toMatchObject({
      code: "NOT_ACTIVE",
      status: 409,
    });
  });

  it("cannot be undone through the generic status change", async () => {
    const service = await suspendedAndPaid();
    await expect(
      changeServiceStatus(db, actorId, service.id, serviceStatusChangeSchema.parse({ status: "active", reason: "Paid" })),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_CHANGE" });
  });
});

describe("requesting a reconnection", () => {
  it("is refused while a past-due invoice is open, and writes nothing", async () => {
    const service = await activeService();
    await openInvoice(service, -20);
    await suspendService(db, actorId, service.id, suspendInput());
    const before = await auditCount(service.id);

    await expect(request(service)).rejects.toMatchObject({ code: "PAYMENT_REQUIRED", status: 409 });
    expect(await db.select().from(reconnectionRecords).where(eq(reconnectionRecords.serviceAccountId, service.id))).toEqual([]);
    expect(await auditCount(service.id)).toBe(before);
  });

  it("is allowed once arrears are paid, even with the current bill open, and snapshots the fee", async () => {
    const service = await suspendedAndPaid();
    await openInvoice(service, 5);
    const reconnection = await request(service);
    expect(reconnection).toMatchObject({
      status: "requested",
      requestDate: today,
      feeCentavos: RECONNECTION_FEE,
      feeWaived: false,
      feeWaiverReason: null,
    });
    const detail = await getServiceAccount(db, service.id);
    expect(detail.events[0]).toMatchObject({ eventType: "reconnection_request" });
  });

  it("allows one open reconnection at a time and only for suspended services", async () => {
    const service = await suspendedAndPaid();
    await request(service);
    await expect(request(service)).rejects.toMatchObject({ code: "RECONNECTION_IN_PROGRESS" });
    const active = await activeService();
    await expect(request(active)).rejects.toMatchObject({ code: "NOT_SUSPENDED" });
  });

  it("keeps a waived fee with its reason", async () => {
    const service = await suspendedAndPaid();
    const reconnection = await request(service, { waiveFee: true, feeWaiverReason: "Outage on our side" });
    expect(reconnection).toMatchObject({ feeWaived: true, feeWaiverReason: "Outage on our side", feeCentavos: RECONNECTION_FEE });
  });
});

describe("assigning, completing and cancelling", () => {
  it("assigns only active technicians; the same technician again writes nothing", async () => {
    const service = await suspendedAndPaid();
    const { id } = await request(service);
    await expect(
      assignReconnection(db, actorId, id, reconnectionAssignSchema.parse({ technicianUserId: cashierId })),
    ).rejects.toMatchObject({ code: "TECHNICIAN_NOT_FOUND", status: 422 });

    const assigned = await assignReconnection(db, actorId, id, reconnectionAssignSchema.parse({ technicianUserId: technicianId }));
    expect(assigned).toMatchObject({ status: "assigned", technicianUserId: technicianId, technicianName: "Test technician" });
    const before = await auditCount(service.id);
    await assignReconnection(db, actorId, id, reconnectionAssignSchema.parse({ technicianUserId: technicianId }));
    expect(await auditCount(service.id)).toBe(before);
    expect(await listTechnicians(db)).toEqual([expect.objectContaining({ id: technicianId })]);
  });

  it("completes: the service is active again and the history says so", async () => {
    const service = await suspendedAndPaid();
    const { id } = await request(service);
    await assignReconnection(db, actorId, id, reconnectionAssignSchema.parse({ technicianUserId: technicianId }));
    const done = await completeReconnection(db, actorId, id, reconnectionCompleteSchema.parse({}));
    expect(done).toMatchObject({ status: "completed", completionDate: today });

    const detail = await getServiceAccount(db, service.id);
    expect(detail.status).toBe("active");
    expect(detail.events[0]).toMatchObject({ eventType: "status_change", fromStatus: "suspended", toStatus: "active" });

    await expect(
      cancelReconnection(db, actorId, id, reconnectionCancelSchema.parse({ reason: "Too late" })),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("re-checks payment on completion", async () => {
    const service = await suspendedAndPaid();
    const { id } = await request(service);
    // e.g. a payment was reversed after the request
    await openInvoice(service, -3);
    await expect(completeReconnection(db, actorId, id, reconnectionCompleteSchema.parse({}))).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
    const [account] = await db.select().from(serviceAccounts).where(eq(serviceAccounts.id, service.id));
    expect(account?.status).toBe("suspended");
  });

  it("cancels: the service stays suspended and a new request is possible", async () => {
    const service = await suspendedAndPaid();
    const { id } = await request(service);
    const cancelled = await cancelReconnection(db, actorId, id, reconnectionCancelSchema.parse({ reason: "Subscriber unreachable" }));
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Subscriber unreachable" });
    expect((await getServiceAccount(db, service.id)).status).toBe("suspended");
    await expect(request(service)).resolves.toMatchObject({ status: "requested" });

    const history = await getServiceControlHistory(db, service.id);
    expect(history.suspensions).toHaveLength(1);
    expect(history.reconnections.map((r) => r.status)).toEqual(["requested", "cancelled"]);
  });

  it("blocks terminating a service while a reconnection is open", async () => {
    const service = await suspendedAndPaid();
    await request(service);
    await expect(
      changeServiceStatus(db, actorId, service.id, serviceStatusChangeSchema.parse({ status: "terminated", reason: "Moved" })),
    ).rejects.toMatchObject({ code: "RECONNECTION_IN_PROGRESS" });
  });
});

describe("reconnection fee in billing", () => {
  const thisMonth = () => billingRunSchema.parse({ period: periodOf(today) });
  const nextMonth = () => billingRunSchema.parse({ period: addMonths(periodOf(today), 1) });

  async function feeLines(serviceId: string) {
    return db
      .select({ amount: invoiceItems.amountCentavos, reconnectionId: invoiceItems.reconnectionId, period: invoices.periodStart })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(and(eq(invoices.serviceAccountId, serviceId), eq(invoiceItems.itemType, "reconnection_fee")));
  }

  async function reconnected(input: Record<string, unknown> = {}) {
    const service = await suspendedAndPaid();
    const { id } = await request(service, input);
    await completeReconnection(db, actorId, id, reconnectionCompleteSchema.parse({}));
    return { service, reconnectionId: id };
  }

  it("bills the fee once on the next generated invoice; discarding the draft frees it", async () => {
    const { service, reconnectionId } = await reconnected();
    const waived = await reconnected({ waiveFee: true, feeWaiverReason: "Our outage" });

    await generateBillingDrafts(db, actorId, thisMonth());
    expect(await feeLines(service.id)).toEqual([
      expect.objectContaining({ amount: RECONNECTION_FEE, reconnectionId }),
    ]);
    expect(await feeLines(waived.service.id)).toEqual([]);

    // Next month's run does not bill it again.
    await generateBillingDrafts(db, actorId, nextMonth());
    expect(await feeLines(service.id)).toHaveLength(1);

    // Discarding this month's drafts frees the fee for the next run.
    await discardBillingDrafts(db, actorId, thisMonth());
    await discardBillingDrafts(db, actorId, nextMonth());
    await generateBillingDrafts(db, actorId, nextMonth());
    expect(await feeLines(service.id)).toEqual([expect.objectContaining({ reconnectionId })]);
    await discardBillingDrafts(db, actorId, nextMonth());
  });
});
