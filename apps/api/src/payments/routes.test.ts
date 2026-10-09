import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  addMonths,
  billingRunSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { dbToday } from "../db/query_helpers";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "Passw0rd!test";
const NIL_ID = "00000000-0000-4000-8000-000000000000";
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/fixtures");
const { db, pool } = createTestDb();
let app: FastifyInstance;
let proofDir: string;
let subscriberId: string;
let olderInvoiceId: string;
let newerInvoiceId: string;
const tokens: Record<string, string> = {};

const bearer = (role: string) => ({ authorization: `Bearer ${tokens[role]}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function postPayment(role: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/payments", headers: bearer(role), payload: { subscriberId, ...payload } });
}

let refCounter = 0;
function recordGcash(role: string, overrides: Record<string, unknown> = {}) {
  refCounter += 1;
  return app.inject({
    method: "POST",
    url: "/gcash-submissions",
    headers: bearer(role),
    payload: {
      subscriberId,
      referenceNumber: `5${String(Date.now()).slice(-8)}${String(refCounter).padStart(4, "0")}`,
      senderName: "Demo Sender",
      senderNumber: "0917 000 1234",
      amountCentavos: 50_000,
      transactionDate: periodBounds(addMonths(periodOf(new Date().toISOString().slice(0, 10)), -1)).end,
      ...overrides,
    },
  });
}

function uploadProof(role: string, submissionId: string, body: Buffer, contentType: string, filename?: string) {
  return app.inject({
    method: "POST",
    url: `/gcash-submissions/${submissionId}/proofs`,
    headers: {
      ...bearer(role),
      "content-type": contentType,
      ...(filename ? { "x-filename": encodeURIComponent(filename) } : {}),
    },
    payload: body,
  });
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  const adminId = await createTestUser(db, "pay_admin", PASSWORD, "administrator");
  await createTestUser(db, "pay_cashier", PASSWORD, "cashier");
  await createTestUser(db, "pay_auditor", PASSWORD, "auditor");
  await createTestUser(db, "pay_viewer", PASSWORD, "viewer");

  const thisMonth = periodOf(await dbToday(db));
  const lastMonth = addMonths(thisMonth, -1);
  const plan = await createPlan(
    db,
    adminId,
    planCreateSchema.parse({ code: "inet-payrt", name: "Internet 25", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    adminId,
    subscriberCreateSchema.parse({
      fullName: "Route Payer",
      billingDay: 5,
      address: { line1: "Purok 4", barangay: "Poblacion", city: "Maramag" },
    }),
  );
  subscriberId = subscriber.id;
  const service = await createServiceAccount(
    db,
    adminId,
    subscriberId,
    serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    adminId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
  );
  for (const period of [lastMonth, thisMonth]) {
    await generateBillingDrafts(db, adminId, billingRunSchema.parse({ period }));
    await finalizeBilling(db, adminId, billingRunSchema.parse({ period }));
  }

  proofDir = await mkdtemp(path.join(os.tmpdir(), "bcis-route-proofs-"));
  app = buildApp(testConfig({ PROOF_STORAGE_DIR: proofDir }), { db, pool });
  await app.ready();
  for (const role of ["admin", "cashier", "auditor", "viewer"]) tokens[role] = await tokenFor(`pay_${role}`);

  const context = await app.inject({
    method: "GET",
    url: `/subscribers/${subscriberId}/payment-context`,
    headers: bearer("cashier"),
  });
  [olderInvoiceId, newerInvoiceId] = (context.json().openInvoices as Array<{ id: string }>).map((i) => i.id) as [
    string,
    string,
  ];
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(proofDir, { recursive: true, force: true });
});

describe("GET /subscribers/:id/payment-context", () => {
  it("gives the balance, credit and open invoices oldest first", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/subscribers/${subscriberId}/payment-context`,
      headers: bearer("auditor"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscriber.id).toBe(subscriberId);
    expect(body.openInvoices).toHaveLength(2);
    expect(body.openInvoices[0].dueDate < body.openInvoices[1].dueDate).toBe(true);
    expect(body.balanceCentavos).toBe(199_800);
    expect(body.creditCentavos).toBe(0);
  });

  it("is 404 for an unknown subscriber and 403 without payment.view", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/subscribers/${NIL_ID}/payment-context`,
      headers: bearer("cashier"),
    });
    expect(missing.statusCode).toBe(404);
    const viewer = await app.inject({
      method: "GET",
      url: `/subscribers/${subscriberId}/payment-context`,
      headers: bearer("viewer"),
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe("POST /payments", () => {
  it("lets a cashier post a cash payment and returns the receipt", async () => {
    const res = await postPayment("cashier", { method: "cash", amountCentavos: 50_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "posted", receiptNumber: expect.stringMatching(/^RCPT-\d{6}$/) as unknown });
    expect(res.json().allocations[0].invoiceId).toBe(olderInvoiceId);
  });

  it("validates input: no GCash at the counter, cheque needs its number", async () => {
    const gcash = await postPayment("cashier", { method: "gcash", amountCentavos: 100, referenceNumber: "123456789" });
    expect(gcash.statusCode).toBe(400);
    const cheque = await postPayment("cashier", { method: "cheque", amountCentavos: 100 });
    expect(cheque.statusCode).toBe(400);
    expect(cheque.json().issues[0].path).toBe("referenceNumber");
  });

  it("refuses manual allocation to a cashier but allows it to an administrator", async () => {
    const allocations = [{ invoiceId: newerInvoiceId, amountCentavos: 100 }];
    const cashier = await postPayment("cashier", { method: "cash", amountCentavos: 100, allocations });
    expect(cashier.statusCode).toBe(403);

    const admin = await postPayment("admin", { method: "cash", amountCentavos: 100, allocations });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().allocations[0]).toMatchObject({ invoiceId: newerInvoiceId, source: "manual" });
  });

  it("reports an invalid manual allocation with the invoice it is about", async () => {
    const res = await postPayment("admin", {
      method: "cash",
      amountCentavos: 999_999,
      allocations: [{ invoiceId: newerInvoiceId, amountCentavos: 999_999 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "ALLOCATION_INVALID", invoiceId: newerInvoiceId });
  });

  it("is refused to roles without payment.create, and to anyone signed out", async () => {
    expect((await postPayment("auditor", { method: "cash", amountCentavos: 100 })).statusCode).toBe(403);
    const anonymous = await app.inject({
      method: "POST",
      url: "/payments",
      payload: { subscriberId, method: "cash", amountCentavos: 100 },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("GET /payments", () => {
  it("finds a payment by receipt number and shows its detail", async () => {
    const posted = (await postPayment("cashier", { method: "other", amountCentavos: 1_000, notes: "Route test" })).json();
    const list = await app.inject({
      method: "GET",
      url: `/payments?search=${posted.receiptNumber}`,
      headers: bearer("auditor"),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((p: { id: string }) => p.id)).toEqual([posted.id]);

    const detail = await app.inject({ method: "GET", url: `/payments/${posted.id}`, headers: bearer("auditor") });
    expect(detail.json()).toMatchObject({ receiptNumber: posted.receiptNumber, notes: "Route test" });
  });

  it("validates filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/payments?from=2026-10-01&to=2026-09-01",
      headers: bearer("cashier"),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /payments/:id/reverse", () => {
  it("needs payment.reverse and a reason, and happens once", async () => {
    const posted = (await postPayment("cashier", { method: "cash", amountCentavos: 2_000 })).json();
    const url = `/payments/${posted.id}/reverse`;

    const cashier = await app.inject({ method: "POST", url, headers: bearer("cashier"), payload: { reason: "Typo" } });
    expect(cashier.statusCode).toBe(403);
    const noReason = await app.inject({ method: "POST", url, headers: bearer("admin"), payload: {} });
    expect(noReason.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url, headers: bearer("admin"), payload: { reason: "Keyed twice" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "reversed", reversal: { reason: "Keyed twice" } });

    const again = await app.inject({ method: "POST", url, headers: bearer("admin"), payload: { reason: "Again" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("PAYMENT_ALREADY_REVERSED");
  });
});

describe("GCash submissions", () => {
  it("records, takes the proof image, and is verified into a payment", async () => {
    const recorded = await recordGcash("cashier");
    expect(recorded.statusCode).toBe(200);
    const id = recorded.json().id as string;

    const image = await readFile(path.join(fixtures, "sample-proof.png"));
    const upload = await uploadProof("cashier", id, image, "image/png", "sample proof.png");
    expect(upload.statusCode).toBe(200);
    expect(upload.json().proofs[0]).toMatchObject({ mimeType: "image/png", sizeBytes: image.length, originalFilename: "sample proof.png" });

    const proof = await app.inject({
      method: "GET",
      url: `/gcash-proofs/${upload.json().proofs[0].id}`,
      headers: bearer("auditor"),
    });
    expect(proof.statusCode).toBe(200);
    expect(proof.headers["content-type"]).toBe("image/png");
    expect(proof.headers["x-content-type-options"]).toBe("nosniff");
    expect(proof.rawPayload.equals(image)).toBe(true);

    const auditor = await app.inject({ method: "POST", url: `/gcash-submissions/${id}/verify`, headers: bearer("auditor") });
    expect(auditor.statusCode).toBe(403);
    const verified = await app.inject({ method: "POST", url: `/gcash-submissions/${id}/verify`, headers: bearer("cashier") });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: "verified", payment: { status: "posted" } });
  });

  it("AT-05: blocks a reference already in use", async () => {
    const first = (await recordGcash("cashier")).json();
    const again = await recordGcash("cashier", { referenceNumber: first.referenceNumber });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("DUPLICATE_REFERENCE");
  });

  it("refuses a file that is not really an image, and types that are not images at all", async () => {
    const id = (await recordGcash("cashier")).json().id as string;
    const fake = await readFile(path.join(fixtures, "not-an-image.png"));

    const renamed = await uploadProof("cashier", id, fake, "image/png", "not-an-image.png");
    expect(renamed.statusCode).toBe(415);
    expect(renamed.json().error).toBe("PROOF_INVALID_TYPE");

    const pdf = await uploadProof("cashier", id, Buffer.from("%PDF-1.7"), "application/pdf");
    expect(pdf.statusCode).toBe(415);
  });

  it("refuses images over 5 MB", async () => {
    const id = (await recordGcash("cashier")).json().id as string;
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    (await readFile(path.join(fixtures, "sample-proof.png"))).copy(big, 0, 0, 16);
    const res = await uploadProof("cashier", id, big, "image/png");
    expect(res.statusCode).toBe(413);

    const huge = await uploadProof("cashier", id, Buffer.alloc(6 * 1024 * 1024), "image/png");
    expect(huge.statusCode).toBe(413);
  });

  it("needs gcash.verify and a reason to reject, and lists the queue", async () => {
    const id = (await recordGcash("cashier")).json().id as string;
    const url = `/gcash-submissions/${id}/reject`;
    expect((await app.inject({ method: "POST", url, headers: bearer("auditor"), payload: { reason: "No" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: bearer("cashier"), payload: {} })).statusCode).toBe(400);

    const queue = await app.inject({ method: "GET", url: "/gcash-submissions?status=pending", headers: bearer("auditor") });
    expect(queue.json().items.some((i: { id: string }) => i.id === id)).toBe(true);

    const rejected = await app.inject({
      method: "POST",
      url,
      headers: bearer("cashier"),
      payload: { reason: "Amount does not match" },
    });
    expect(rejected.json()).toMatchObject({ status: "rejected", rejectionReason: "Amount does not match" });
  });

  it("does not let a viewer read proofs or the queue", async () => {
    const res = await app.inject({ method: "GET", url: "/gcash-submissions", headers: bearer("viewer") });
    expect(res.statusCode).toBe(403);
    const proof = await app.inject({ method: "GET", url: `/gcash-proofs/${NIL_ID}`, headers: bearer("viewer") });
    expect(proof.statusCode).toBe(403);
  });
});
