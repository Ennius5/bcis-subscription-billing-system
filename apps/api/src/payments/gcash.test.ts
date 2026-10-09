import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  addMonths,
  billingRunSchema,
  gcashSubmissionCreateSchema,
  parsePesos,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { getSubscriberBalance } from "../billing/ledger";
import { dbToday } from "../db/query_helpers";
import { auditLogs, paymentProofs, payments } from "../db/schema";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase } from "../test/helpers";
import {
  addSubmissionProof,
  createGcashSubmission,
  listGcashSubmissions,
  readSubmissionProof,
  rejectGcashSubmission,
  verifyGcashSubmission,
} from "./gcash";
import { displayFilename, ProofStore } from "./proof-storage";
import { reversePayment } from "./service";

const { db, pool } = createTestDb();
let actorId: string;
let verifierId: string;
let proofDir: string;
let store: ProofStore;
let subscriberId: string;
let lastMonth: string;
let today: string;
let refCounter = 0;

// Only the first bytes decide the type, so a signature plus filler is enough for these tests.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => i)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function nextReference(): string {
  refCounter += 1;
  return `9${String(Date.now()).slice(-8)}${String(refCounter).padStart(4, "0")}`;
}

function record(overrides: Record<string, unknown> = {}) {
  return createGcashSubmission(
    db,
    actorId,
    gcashSubmissionCreateSchema.parse({
      subscriberId,
      referenceNumber: nextReference(),
      senderName: "Demo Sender",
      senderNumber: "0917 000 4567",
      amountCentavos: 99_900,
      transactionDate: today,
      ...overrides,
    }),
  );
}

async function recordWithProof(overrides: Record<string, unknown> = {}) {
  const submission = await record(overrides);
  return addSubmissionProof(db, store, actorId, submission.id, { bytes: PNG, filename: "gcash-receipt.png" });
}

async function storedFiles(): Promise<string[]> {
  return readdir(proofDir).catch(() => []);
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(sql`TRUNCATE subscribers, service_plans, billing_cycles CASCADE`);
  actorId = await createTestUser(db, "gcash_recorder", "Passw0rd!test", "cashier");
  verifierId = await createTestUser(db, "gcash_verifier", "Passw0rd!test", "administrator");
  proofDir = await mkdtemp(path.join(os.tmpdir(), "bcis-proofs-"));
  store = new ProofStore(proofDir);

  today = await dbToday(db);
  lastMonth = addMonths(periodOf(today), -1);
  const planId = (
    await createPlan(
      db,
      actorId,
      planCreateSchema.parse({ code: "inet-gcash", name: "Internet", serviceType: "internet", priceCentavos: 99_900 }),
    )
  ).id;
  const subscriber = await createSubscriber(
    db,
    actorId,
    subscriberCreateSchema.parse({
      fullName: "GCash Payer",
      billingDay: 5,
      address: { line1: "Purok 3", barangay: "Poblacion", city: "Maramag" },
    }),
  );
  subscriberId = subscriber.id;
  const service = await createServiceAccount(
    db,
    actorId,
    subscriberId,
    serviceAccountCreateSchema.parse({ planId, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    actorId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(lastMonth).start }),
  );
  await generateBillingDrafts(db, actorId, billingRunSchema.parse({ period: lastMonth }));
  await finalizeBilling(db, actorId, billingRunSchema.parse({ period: lastMonth }));
});

afterAll(async () => {
  await pool.end();
  await rm(proofDir, { recursive: true, force: true });
});

describe("recording a submission", () => {
  it("stores it pending with the reference normalized, and masks the sender's number in the audit", async () => {
    const submission = await record({ referenceNumber: "8012 345 678901" });

    expect(submission).toMatchObject({
      status: "pending",
      referenceNumber: "8012345678901",
      senderNumber: "0917 000 4567",
      proofCount: 0,
      payment: null,
    });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "gcash.record"), eq(auditLogs.entityId, submission.id)));
    expect(audit?.newValues).toMatchObject({ senderNumber: "***4567", referenceNumber: "8012345678901" });
    expect(JSON.stringify(audit?.newValues)).not.toContain("0917");
  });

  it("refuses a transaction date in the future", async () => {
    await expect(record({ transactionDate: periodBounds(addMonths(periodOf(today), 1)).end })).rejects.toMatchObject({
      code: "TRANSACTION_DATE_IN_FUTURE",
    });
  });
});

describe("AT-05: duplicate GCash reference", () => {
  it("blocks a reference that is already pending, however it is spaced", async () => {
    await record({ referenceNumber: "7000111222333" });
    await expect(record({ referenceNumber: "7000 111 222 333" })).rejects.toMatchObject({
      code: "DUPLICATE_REFERENCE",
      message: expect.stringContaining("pending verification") as unknown,
    });
  });

  it("blocks a reference already posted, naming its receipt", async () => {
    const submission = await recordWithProof({ referenceNumber: "7000444555666" });
    const verified = await verifyGcashSubmission(db, verifierId, submission.id);

    await expect(record({ referenceNumber: "7000444555666" })).rejects.toMatchObject({
      code: "DUPLICATE_REFERENCE",
      message: expect.stringContaining(verified.payment!.receiptNumber) as unknown,
    });
  });

  it("frees the reference after a rejection", async () => {
    const submission = await record({ referenceNumber: "7000777888999" });
    await rejectGcashSubmission(db, verifierId, submission.id, { reason: "Not in the GCash history" });
    await expect(record({ referenceNumber: "7000777888999" })).resolves.toMatchObject({ status: "pending" });
  });

  it("frees the reference after the payment is reversed", async () => {
    const submission = await recordWithProof({ referenceNumber: "7000123123123" });
    const verified = await verifyGcashSubmission(db, verifierId, submission.id);
    await reversePayment(db, verifierId, verified.payment!.id, { reason: "Posted to the wrong subscriber" });

    const [after] = (await listGcashSubmissions(db, { page: 1, pageSize: 100, status: "reversed" })).items.filter(
      (i) => i.id === submission.id,
    );
    expect(after?.status).toBe("reversed");
    await expect(record({ referenceNumber: "7000123123123" })).resolves.toMatchObject({ status: "pending" });
  });
});

describe("proof images", () => {
  it("are stored under a new UUID name with their checksum, and can be read back", async () => {
    const before = await storedFiles();
    const submission = await recordWithProof();

    expect(submission.proofs).toHaveLength(1);
    expect(submission.proofs[0]).toMatchObject({ mimeType: "image/png", sizeBytes: PNG.length, originalFilename: "gcash-receipt.png" });
    const added = (await storedFiles()).filter((f) => !before.includes(f));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^[0-9a-f-]{36}\.png$/);

    const [row] = await db.select().from(paymentProofs).where(eq(paymentProofs.id, submission.proofs[0]!.id));
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Uint8Array(await readFile(path.join(proofDir, row!.storageKey)))).toEqual(PNG);

    const read = await readSubmissionProof(db, store, submission.proofs[0]!.id);
    expect(read.mimeType).toBe("image/png");
    expect(new Uint8Array(read.bytes)).toEqual(PNG);
  });

  it("are refused when not an image, empty or too large, leaving no file behind", async () => {
    const submission = await record();
    const before = await storedFiles();
    const attach = (bytes: Uint8Array, filename: string) =>
      addSubmissionProof(db, store, actorId, submission.id, { bytes, filename });

    await expect(attach(new TextEncoder().encode("%PDF-1.7"), "receipt.png")).rejects.toMatchObject({
      code: "PROOF_INVALID_TYPE",
    });
    await expect(attach(new Uint8Array(), "empty.png")).rejects.toMatchObject({ code: "PROOF_EMPTY" });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    await expect(attach(big, "big.png")).rejects.toMatchObject({ code: "PROOF_TOO_LARGE" });

    expect(await storedFiles()).toEqual(before);
    expect(await db.select().from(paymentProofs).where(eq(paymentProofs.gcashSubmissionId, submission.id))).toHaveLength(0);
  });

  it("can only be added while the submission is pending, and the file is cleaned up", async () => {
    const submission = await record();
    await rejectGcashSubmission(db, verifierId, submission.id, { reason: "Duplicate message" });
    const before = await storedFiles();
    await expect(
      addSubmissionProof(db, store, actorId, submission.id, { bytes: JPEG, filename: "late.jpg" }),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_PENDING" });
    expect(await storedFiles()).toEqual(before);
  });

  it("keep only a display name from the uploader, never a path", () => {
    expect(displayFilename("C:\\Users\\demo\\..\\Pictures\\proof.png")).toBe("proof.png");
    expect(displayFilename("../../etc/passwd")).toBe("passwd");
    expect(displayFilename("a\u0000b.png")).toBe("ab.png");
    expect(displayFilename("")).toBeNull();
  });

  it("refuse storage keys that could leave the folder", async () => {
    await expect(store.read("../secret.png")).rejects.toThrow(/Invalid proof storage key/);
    await expect(store.read("00000000-0000-4000-8000-000000000001.exe")).rejects.toThrow(/Invalid proof storage key/);
  });
});

describe("verification", () => {
  it("an uploaded screenshot alone changes nothing on the account", async () => {
    const balance = await getSubscriberBalance(db, subscriberId);
    const paymentsBefore = (await db.select().from(payments).where(eq(payments.subscriberId, subscriberId))).length;

    await recordWithProof();

    expect(await getSubscriberBalance(db, subscriberId)).toBe(balance);
    expect((await db.select().from(payments).where(eq(payments.subscriberId, subscriberId))).length).toBe(paymentsBefore);
  });

  it("needs a proof image", async () => {
    const submission = await record();
    await expect(verifyGcashSubmission(db, verifierId, submission.id)).rejects.toMatchObject({ code: "PROOF_REQUIRED" });
  });

  it("posts a GCash payment dated on the transaction, keeping who verified it and when", async () => {
    const paidOn = periodBounds(lastMonth).end;
    const submission = await recordWithProof({ amountCentavos: parsePesos("500"), transactionDate: paidOn });
    const balance = await getSubscriberBalance(db, subscriberId);

    const verified = await verifyGcashSubmission(db, verifierId, submission.id);

    expect(verified).toMatchObject({ status: "verified", reviewedByName: expect.any(String) as unknown });
    expect(verified.reviewedAt).toBeInstanceOf(Date);
    expect(verified.payment).toMatchObject({ status: "posted", receiptNumber: expect.stringMatching(/^RCPT-/) as unknown });

    const [payment] = await db.select().from(payments).where(eq(payments.id, verified.payment!.id));
    expect(payment).toMatchObject({
      method: "gcash",
      amountCentavos: parsePesos("500"),
      paymentDate: paidOn,
      referenceNumber: submission.referenceNumber,
      gcashSubmissionId: submission.id,
      receivedByUserId: verifierId,
    });
    expect(await getSubscriberBalance(db, subscriberId)).toBe(balance - parsePesos("500"));
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "gcash.verify"), eq(auditLogs.entityId, submission.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(verifierId);
  });

  it("happens once; a verified or rejected submission cannot be reviewed again", async () => {
    const submission = await recordWithProof();
    await verifyGcashSubmission(db, verifierId, submission.id);
    await expect(verifyGcashSubmission(db, verifierId, submission.id)).rejects.toMatchObject({
      code: "SUBMISSION_NOT_PENDING",
    });
    await expect(
      rejectGcashSubmission(db, verifierId, submission.id, { reason: "Changed my mind" }),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_PENDING" });
  });
});

describe("rejection", () => {
  it("keeps the reason and who rejected it, and posts nothing", async () => {
    const submission = await recordWithProof();
    const rejected = await rejectGcashSubmission(db, verifierId, submission.id, { reason: "Amount does not match" });

    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Amount does not match", payment: null });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "gcash.reject"), eq(auditLogs.entityId, submission.id)));
    expect(audits[0]).toMatchObject({ actorUserId: verifierId, reason: "Amount does not match" });
  });
});

describe("the queue", () => {
  it("lists pending submissions oldest first", async () => {
    const first = await record();
    const second = await record();
    const page = await listGcashSubmissions(db, { page: 1, pageSize: 100, status: "pending" });
    const ids = page.items.map((i) => i.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(page.items.every((i) => i.status === "pending")).toBe(true);
  });
});
