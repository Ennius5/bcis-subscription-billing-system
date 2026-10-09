import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  gcashSubmissionCreateSchema,
  GLOBAL_SEARCH_LIMIT,
  globalSearchQuerySchema,
  paymentCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  subscriberCreateSchema,
  subscriberStatusChangeSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createGcashSubmission } from "../payments/gcash";
import { postPayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { createServiceAccount } from "../service-accounts/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { globalSearch } from "./search";
import { changeSubscriberStatus, createSubscriber, updateSubscriberContact } from "./service";

const PASSWORD = "Passw0rd!test";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let actorId: string;
let anaId: string;
let anaAccount: string;
let benId: string;
let anaServiceNumber: string;

const search = (q: string) => globalSearch(db, globalSearchQuerySchema.parse({ q }));
const names = (result: Awaited<ReturnType<typeof search>>) => result.items.map((i) => i.fullName);

function newSubscriber(fullName: string, overrides: Record<string, unknown> = {}) {
  return subscriberCreateSchema.parse({
    fullName,
    billingDay: 5,
    address: { line1: "Purok 1", barangay: "Poblacion", city: "Maramag", province: "Bukidnon" },
    ...overrides,
  });
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "search_admin", PASSWORD, "administrator");
  await createTestUser(db, "search_cashier", PASSWORD, "cashier");
  await createTestUser(db, "search_tech", PASSWORD, "technician");

  const ana = await createSubscriber(
    db,
    actorId,
    newSubscriber("Ana Reyes", {
      address: { line1: "Purok 5", barangay: "Panalsalan", city: "Maramag", landmark: "Near the chapel" },
      contacts: [
        { type: "mobile", value: "0917 123 4567", isPrimary: true },
        { type: "email", value: "ana.reyes@example.com" },
      ],
    }),
  );
  anaId = ana.id;
  anaAccount = ana.accountNumber;

  benId = (
    await createSubscriber(
      db,
      actorId,
      newSubscriber("Ben Cruz", { contacts: [{ type: "mobile", value: "+63 918 765 4321", isPrimary: true }] }),
    )
  ).id;
  await createSubscriber(db, actorId, newSubscriber("Juana Santos"));
  await createSubscriber(db, actorId, newSubscriber("Carla 100% Cruz"));

  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({
        code: "inet-25",
        name: "Internet 25",
        serviceType: "internet",
        priceCentavos: 99900,
        speedMbps: 25,
      }),
    )
  ).id;
  anaServiceNumber = (
    await createServiceAccount(
      db,
      actorId,
      anaId,
      serviceAccountCreateSchema.parse({ planId, installationAddressId: ana.addresses[0]!.id }),
    )
  ).serviceNumber;

  app = buildApp(
    testConfig(),
    { db, pool },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("globalSearch", () => {
  it("finds names case-insensitively and lists everything that matched", async () => {
    const result = await search("reyes");
    expect(names(result)).toEqual(["Ana Reyes"]);
    expect(result.items[0]).toMatchObject({
      accountNumber: anaAccount,
      primaryContact: "0917 123 4567",
      primaryAddress: "Purok 5, Panalsalan, Maramag",
      // Her email contains "reyes" too, so both are reported.
      matches: [
        { field: "name", value: "Ana Reyes" },
        { field: "contact", value: "ana.reyes@example.com" },
      ],
    });
    expect(result.hasMore).toBe(false);
  });

  it("puts an exact account number first", async () => {
    const result = await search(anaAccount.toLowerCase());
    expect(result.items[0]?.id).toBe(anaId);
    expect(result.items[0]?.matches).toContainEqual({ field: "accountNumber", value: anaAccount });
  });

  it("puts names starting with the query before names that only contain it", async () => {
    // "Ana Reyes" starts with "an"; "Juana Santos" only contains it.
    expect(names(await search("an")).slice(0, 2)).toEqual(["Ana Reyes", "Juana Santos"]);
  });

  it("finds a subscriber by service number", async () => {
    const result = await search(anaServiceNumber);
    expect(names(result)).toEqual(["Ana Reyes"]);
    expect(result.items[0]?.matches).toEqual([{ field: "serviceNumber", value: anaServiceNumber }]);
  });

  it("matches phone numbers on digits, in local and international form", async () => {
    for (const q of ["09171234567", "0917-123-4567", "+639171234567", "1234567"]) {
      const result = await search(q);
      expect(names(result), q).toEqual(["Ana Reyes"]);
      expect(result.items[0]?.matches).toEqual([{ field: "contact", value: "0917 123 4567" }]);
    }
    // Ben's number was stored as +63; the local form still finds it.
    expect(names(await search("0918 765 4321"))).toEqual(["Ben Cruz"]);
  });

  it("finds an email contact as typed", async () => {
    const result = await search("ana.reyes@");
    expect(result.items[0]?.matches).toEqual([{ field: "contact", value: "ana.reyes@example.com" }]);
  });

  it("still finds a subscriber by a deactivated contact", async () => {
    const detail = await createSubscriber(
      db,
      actorId,
      newSubscriber("Dina Old Number", {
        contacts: [
          { type: "mobile", value: "09995550001", isPrimary: true },
          { type: "mobile", value: "09995550002" },
        ],
      }),
    );
    const old = detail.contacts.find((c) => c.value === "09995550002")!;
    await updateSubscriberContact(db, actorId, detail.id, old.id, { isActive: false });
    expect(names(await search("09995550002"))).toEqual(["Dina Old Number"]);
  });

  it("finds addresses by any part, including the landmark", async () => {
    const result = await search("chapel");
    expect(names(result)).toEqual(["Ana Reyes"]);
    expect(result.items[0]?.matches).toEqual([{ field: "address", value: "Purok 5, Panalsalan, Maramag" }]);
    expect(names(await search("panalsalan"))).toEqual(["Ana Reyes"]);
  });

  it("includes archived subscribers, with their status", async () => {
    const id = (await createSubscriber(db, actorId, newSubscriber("Ernesto Archived"))).id;
    for (const status of ["terminated", "archived"]) {
      await changeSubscriberStatus(
        db,
        actorId,
        id,
        subscriberStatusChangeSchema.parse({ status, reason: "Closed account" }),
      );
    }
    const result = await search("ernesto");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("archived");
  });

  it("treats % and _ literally", async () => {
    expect(names(await search("0%"))).toEqual(["Carla 100% Cruz"]);
    expect((await search("a_a")).items).toHaveLength(0);
  });

  it("lists a subscriber once even when several things match", async () => {
    // "maramag" is in every address; Ana matches on the address only once.
    const result = await search("maramag");
    expect(new Set(result.items.map((i) => i.id)).size).toBe(result.items.length);
  });

  it("returns at most the limit and reports that there is more", async () => {
    for (let i = 0; i < GLOBAL_SEARCH_LIMIT; i++) {
      await createSubscriber(db, actorId, newSubscriber(`Bulk Person ${String(i).padStart(2, "0")}`));
    }
    const result = await search("bulk person");
    expect(result.items).toHaveLength(GLOBAL_SEARCH_LIMIT);
    expect(result.hasMore).toBe(false);

    await createSubscriber(db, actorId, newSubscriber("Bulk Person 99"));
    const more = await search("bulk person");
    expect(more.items).toHaveLength(GLOBAL_SEARCH_LIMIT);
    expect(more.hasMore).toBe(true);
  });

  it("returns nothing for an unknown query", async () => {
    expect((await search("zzzz-nobody")).items).toEqual([]);
  });
});

describe("GET /search", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function tokenFor(username: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  it("rejects requests with no token", async () => {
    expect((await app.inject({ method: "GET", url: "/search?q=ana" })).statusCode).toBe(401);
  });

  it("rejects a technician, who has no subscriber.view", async () => {
    const headers = bearer(await tokenFor("search_tech"));
    expect((await app.inject({ method: "GET", url: "/search?q=ana", headers })).statusCode).toBe(403);
  });

  it("lets a cashier search", async () => {
    const headers = bearer(await tokenFor("search_cashier"));
    const res = await app.inject({ method: "GET", url: `/search?q=${encodeURIComponent("0917 123 4567")}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].id).toBe(anaId);
  });

  it("rejects a query that is too short or missing", async () => {
    const headers = bearer(await tokenFor("search_cashier"));
    const short = await app.inject({ method: "GET", url: "/search?q=a", headers });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe("VALIDATION");
    expect((await app.inject({ method: "GET", url: "/search", headers })).statusCode).toBe(400);
  });

  it("does not leak Ben's data into an unrelated search", async () => {
    const headers = bearer(await tokenFor("search_cashier"));
    const res = await app.inject({ method: "GET", url: "/search?q=reyes", headers });
    expect(res.json().items.map((i: { id: string }) => i.id)).not.toContain(benId);
  });
});

describe("globalSearch by receipt, invoice and GCash reference", () => {
  let receiptNumber: string;
  const invoiceNumber = "INV-SRCH01";

  beforeAll(async () => {
    receiptNumber = (
      await postPayment(db, actorId, paymentCreateSchema.parse({ subscriberId: benId, method: "cash", amountCentavos: 50_000 }))
    ).receiptNumber;
    await createGcashSubmission(
      db,
      actorId,
      gcashSubmissionCreateSchema.parse({
        subscriberId: anaId,
        referenceNumber: "8123456789012",
        senderName: "Demo Sender",
        senderNumber: "0917 000 0001",
        amountCentavos: 99_900,
        transactionDate: "2026-01-15",
      }),
    );
    // A finalized invoice for Ana, inserted directly: only its number matters here.
    const cycle = await pool.query<{ id: string }>(
      `INSERT INTO billing_cycles (period_start, period_end, created_by_user_id) VALUES ('2026-01-01', '2026-01-31', $1) RETURNING id`,
      [actorId],
    );
    const service = await pool.query<{ id: string }>(`SELECT id FROM service_accounts WHERE subscriber_id = $1`, [anaId]);
    await pool.query(
      `INSERT INTO invoices (billing_cycle_id, subscriber_id, service_account_id, period_start, period_end, invoice_date,
                             due_date, total_centavos, created_by_user_id, status, invoice_number, finalized_at, finalized_by_user_id)
       VALUES ($1, $2, $3, '2026-01-01', '2026-01-31', '2026-01-01', '2026-01-05', 99900, $4, 'unpaid', $5, now(), $4)`,
      [cycle.rows[0]!.id, anaId, service.rows[0]!.id, actorId, invoiceNumber],
    );
  });

  it("finds the subscriber a receipt belongs to, exact match first", async () => {
    const result = await search(receiptNumber.toLowerCase());
    expect(result.items[0]?.id).toBe(benId);
    expect(result.items[0]?.matches).toContainEqual({ field: "receiptNumber", value: receiptNumber });
  });

  it("finds the subscriber an invoice belongs to", async () => {
    const result = await search(invoiceNumber);
    expect(names(result)).toEqual(["Ana Reyes"]);
    expect(result.items[0]?.matches).toEqual([{ field: "invoiceNumber", value: invoiceNumber }]);
  });

  it("finds a GCash reference however it is spaced", async () => {
    for (const q of ["8123456789012", "8123 456 789 012", "456789"]) {
      const result = await search(q);
      expect(result.items[0]?.id).toBe(anaId);
      expect(result.items[0]?.matches).toContainEqual({ field: "gcashReference", value: "8123456789012" });
    }
  });
});
