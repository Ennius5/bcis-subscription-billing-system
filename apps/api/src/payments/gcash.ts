import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  GCASH_PROOFS_MAX,
  type GcashRejectInput,
  type GcashSubmissionCreateInput,
  type GcashSubmissionListQuery,
} from "@bcis/shared";
import { writeAudit, type DbOrTx } from "../audit/audit";
import type { Db } from "../db/client";
import { dbToday, violatedConstraint } from "../db/query_helpers";
import { gcashSubmissions, paymentProofs, payments, subscribers, users } from "../db/schema";
import { displayFilename, type ProofStore } from "./proof-storage";
import { postPaymentInTx } from "./service";

/*
 * GCash verification (spec 3.7). A submission is what the customer reported: evidence, not
 * money. It becomes a payment only when an authorized user verifies it; uploading an image
 * changes nothing on the account. A reference can be live (pending or verified) only once,
 * which the database enforces with gcash_submissions_live_reference_idx (AT-05).
 */

export class GcashError extends Error {
  constructor(
    public readonly code:
      | "SUBSCRIBER_NOT_FOUND"
      | "SUBSCRIBER_ARCHIVED"
      | "TRANSACTION_DATE_IN_FUTURE"
      | "DUPLICATE_REFERENCE"
      | "SUBMISSION_NOT_FOUND"
      | "SUBMISSION_NOT_PENDING"
      | "PROOF_REQUIRED"
      | "PROOF_LIMIT"
      | "PROOF_NOT_FOUND",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LIVE_REFERENCE_INDEX = "gcash_submissions_live_reference_idx";

/** Audit rows show only the last 4 digits of the sender's number. */
function maskNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

/** Explains where a reference is already in use, so staff can find the earlier record. */
async function duplicateReferenceError(executor: DbOrTx, referenceNumber: string): Promise<GcashError> {
  const [live] = await executor
    .select({
      status: gcashSubmissions.status,
      recordedAt: gcashSubmissions.recordedAt,
      accountNumber: subscribers.accountNumber,
      receiptNumber: payments.receiptNumber,
    })
    .from(gcashSubmissions)
    .innerJoin(subscribers, eq(subscribers.id, gcashSubmissions.subscriberId))
    .leftJoin(payments, eq(payments.gcashSubmissionId, gcashSubmissions.id))
    .where(
      and(
        eq(gcashSubmissions.referenceNumber, referenceNumber),
        inArray(gcashSubmissions.status, ["pending", "verified"]),
      ),
    );
  const where = !live
    ? "on another submission"
    : live.status === "verified"
      ? `by receipt ${live.receiptNumber} (account ${live.accountNumber})`
      : `by a submission still pending verification (account ${live.accountNumber})`;
  return new GcashError("DUPLICATE_REFERENCE", 409, `GCash reference ${referenceNumber} is already used ${where}.`);
}

/* ------------------------------- Record ------------------------------- */

export async function createGcashSubmission(
  db: Db,
  actorUserId: string,
  input: GcashSubmissionCreateInput,
): Promise<GcashSubmissionDetail> {
  try {
    return await db.transaction(async (tx) => {
      const [subscriber] = await tx
        .select({ status: subscribers.status, accountNumber: subscribers.accountNumber })
        .from(subscribers)
        .where(eq(subscribers.id, input.subscriberId));
      if (!subscriber) throw new GcashError("SUBSCRIBER_NOT_FOUND", 404, "Subscriber not found.");
      if (subscriber.status === "archived") {
        throw new GcashError("SUBSCRIBER_ARCHIVED", 409, `Subscriber ${subscriber.accountNumber} is archived.`);
      }
      if (input.transactionDate > (await dbToday(tx))) {
        throw new GcashError("TRANSACTION_DATE_IN_FUTURE", 422, "The transaction date cannot be in the future.");
      }

      const [row] = await tx
        .insert(gcashSubmissions)
        .values({
          subscriberId: input.subscriberId,
          referenceNumber: input.referenceNumber,
          senderName: input.senderName,
          senderNumber: input.senderNumber,
          amountCentavos: input.amountCentavos,
          transactionDate: input.transactionDate,
          notes: input.notes || null,
          recordedByUserId: actorUserId,
        })
        .returning({ id: gcashSubmissions.id });

      await writeAudit(tx, {
        actorUserId,
        action: "gcash.record",
        entityType: "gcash_submission",
        entityId: row!.id,
        newValues: {
          subscriberId: input.subscriberId,
          referenceNumber: input.referenceNumber,
          senderName: input.senderName,
          senderNumber: maskNumber(input.senderNumber),
          amountCentavos: input.amountCentavos,
          transactionDate: input.transactionDate,
        },
      });
      return fetchSubmission(tx, row!.id);
    });
  } catch (err) {
    // The unique index is the real guard: it also catches two PCs recording the same reference at once.
    if (violatedConstraint(err) === LIVE_REFERENCE_INDEX) throw await duplicateReferenceError(db, input.referenceNumber);
    throw err;
  }
}

/* -------------------------------- Proofs -------------------------------- */

/**
 * Attaches a proof image to a pending submission. The file is checked and written first,
 * then recorded; if recording fails the file is removed again.
 */
export async function addSubmissionProof(
  db: Db,
  store: ProofStore,
  actorUserId: string,
  submissionId: string,
  file: { bytes: Uint8Array; filename?: string | null },
): Promise<GcashSubmissionDetail> {
  // Checked before touching the disk, and again under lock below.
  await requirePending(db, submissionId);
  const stored = await store.save(file.bytes);
  try {
    return await db.transaction(async (tx) => {
      const submission = await requirePending(tx, submissionId, true);
      if ((await proofCount(tx, submissionId)) >= GCASH_PROOFS_MAX) {
        throw new GcashError("PROOF_LIMIT", 409, `A submission can have at most ${GCASH_PROOFS_MAX} images.`);
      }

      const [proof] = await tx
        .insert(paymentProofs)
        .values({
          gcashSubmissionId: submissionId,
          storageKey: stored.storageKey,
          originalFilename: displayFilename(file.filename),
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          uploadedByUserId: actorUserId,
        })
        .returning({ id: paymentProofs.id });

      await writeAudit(tx, {
        actorUserId,
        action: "gcash.proof_upload",
        entityType: "gcash_submission",
        entityId: submissionId,
        newValues: {
          proofId: proof!.id,
          referenceNumber: submission.referenceNumber,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
        },
      });
      return fetchSubmission(tx, submissionId);
    });
  } catch (err) {
    await store.discard(stored.storageKey);
    throw err;
  }
}

/** A proof image's bytes, for the verification screen. */
export async function readSubmissionProof(
  db: Db,
  store: ProofStore,
  proofId: string,
): Promise<{ mimeType: string; bytes: Buffer }> {
  const [proof] = await db
    .select({ storageKey: paymentProofs.storageKey, mimeType: paymentProofs.mimeType })
    .from(paymentProofs)
    .where(eq(paymentProofs.id, proofId));
  if (!proof) throw new GcashError("PROOF_NOT_FOUND", 404, "Proof image not found.");
  return { mimeType: proof.mimeType, bytes: await store.read(proof.storageKey) };
}

async function proofCount(executor: DbOrTx, submissionId: string): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(paymentProofs)
    .where(eq(paymentProofs.gcashSubmissionId, submissionId));
  return row?.value ?? 0;
}

async function requirePending(executor: DbOrTx, submissionId: string, lock = false) {
  const query = executor.select().from(gcashSubmissions).where(eq(gcashSubmissions.id, submissionId));
  const [submission] = lock ? await query.for("update") : await query;
  if (!submission) throw new GcashError("SUBMISSION_NOT_FOUND", 404, "GCash submission not found.");
  if (submission.status !== "pending") {
    throw new GcashError(
      "SUBMISSION_NOT_PENDING",
      409,
      `GCash reference ${submission.referenceNumber} is already ${submission.status}.`,
    );
  }
  return submission;
}

/* --------------------------- Verify / reject --------------------------- */

/**
 * Verifies a pending submission: it becomes a posted GCash payment (receipt, ledger credit,
 * oldest-first allocation, credit for any remainder), dated on the GCash transaction date.
 * At least one proof image must be attached. The verifier and time are kept (spec 3.7 step 6).
 */
export async function verifyGcashSubmission(
  db: Db,
  actorUserId: string,
  submissionId: string,
): Promise<GcashSubmissionDetail> {
  return db.transaction(async (tx) => {
    const submission = await requirePending(tx, submissionId, true);
    if ((await proofCount(tx, submissionId)) === 0) {
      throw new GcashError("PROOF_REQUIRED", 409, "Attach the proof image before verifying.");
    }

    await tx
      .update(gcashSubmissions)
      .set({ status: "verified", reviewedByUserId: actorUserId, reviewedAt: sql`now()` })
      .where(eq(gcashSubmissions.id, submissionId));

    const paymentId = await postPaymentInTx(tx, actorUserId, {
      subscriberId: submission.subscriberId,
      method: "gcash",
      amountCentavos: submission.amountCentavos,
      paymentDate: submission.transactionDate,
      referenceNumber: submission.referenceNumber,
      gcashSubmissionId: submissionId,
    });

    await writeAudit(tx, {
      actorUserId,
      action: "gcash.verify",
      entityType: "gcash_submission",
      entityId: submissionId,
      oldValues: { status: "pending" },
      newValues: {
        status: "verified",
        referenceNumber: submission.referenceNumber,
        amountCentavos: submission.amountCentavos,
        paymentId,
      },
    });
    return fetchSubmission(tx, submissionId);
  });
}

export async function rejectGcashSubmission(
  db: Db,
  actorUserId: string,
  submissionId: string,
  input: GcashRejectInput,
): Promise<GcashSubmissionDetail> {
  return db.transaction(async (tx) => {
    const submission = await requirePending(tx, submissionId, true);
    await tx
      .update(gcashSubmissions)
      .set({
        status: "rejected",
        reviewedByUserId: actorUserId,
        reviewedAt: sql`now()`,
        rejectionReason: input.reason,
      })
      .where(eq(gcashSubmissions.id, submissionId));

    await writeAudit(tx, {
      actorUserId,
      action: "gcash.reject",
      entityType: "gcash_submission",
      entityId: submissionId,
      reason: input.reason,
      oldValues: { status: "pending" },
      newValues: { status: "rejected", referenceNumber: submission.referenceNumber },
    });
    return fetchSubmission(tx, submissionId);
  });
}

/* ------------------------------- Reading ------------------------------- */

export interface GcashSubmissionListItem {
  id: string;
  status: string;
  referenceNumber: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  senderName: string;
  amountCentavos: number;
  transactionDate: string;
  recordedAt: Date;
  recordedByName: string;
  proofCount: number;
}

export interface GcashSubmissionDetail extends GcashSubmissionListItem {
  senderNumber: string;
  notes: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  payment: { id: string; receiptNumber: string; status: string } | null;
  proofs: Array<{
    id: string;
    mimeType: string;
    sizeBytes: number;
    originalFilename: string | null;
    uploadedAt: Date;
  }>;
}

const recorder = alias(users, "recorder");
const reviewer = alias(users, "reviewer");

const listColumns = {
  id: gcashSubmissions.id,
  status: gcashSubmissions.status,
  referenceNumber: gcashSubmissions.referenceNumber,
  subscriberId: gcashSubmissions.subscriberId,
  accountNumber: subscribers.accountNumber,
  subscriberName: subscribers.fullName,
  senderName: gcashSubmissions.senderName,
  amountCentavos: gcashSubmissions.amountCentavos,
  transactionDate: gcashSubmissions.transactionDate,
  recordedAt: gcashSubmissions.recordedAt,
  recordedByName: recorder.fullName,
  proofCount: sql<number>`(SELECT count(*)::int FROM payment_proofs p WHERE p.gcash_submission_id = ${gcashSubmissions.id})`,
};

async function fetchSubmission(executor: DbOrTx, submissionId: string): Promise<GcashSubmissionDetail> {
  const [row] = await executor
    .select({
      ...listColumns,
      senderNumber: gcashSubmissions.senderNumber,
      notes: gcashSubmissions.notes,
      reviewedByName: reviewer.fullName,
      reviewedAt: gcashSubmissions.reviewedAt,
      rejectionReason: gcashSubmissions.rejectionReason,
    })
    .from(gcashSubmissions)
    .innerJoin(subscribers, eq(subscribers.id, gcashSubmissions.subscriberId))
    .innerJoin(recorder, eq(recorder.id, gcashSubmissions.recordedByUserId))
    .leftJoin(reviewer, eq(reviewer.id, gcashSubmissions.reviewedByUserId))
    .where(eq(gcashSubmissions.id, submissionId));
  if (!row) throw new GcashError("SUBMISSION_NOT_FOUND", 404, "GCash submission not found.");

  const [payment] = await executor
    .select({ id: payments.id, receiptNumber: payments.receiptNumber, status: payments.status })
    .from(payments)
    .where(eq(payments.gcashSubmissionId, submissionId));

  const proofs = await executor
    .select({
      id: paymentProofs.id,
      mimeType: paymentProofs.mimeType,
      sizeBytes: paymentProofs.sizeBytes,
      originalFilename: paymentProofs.originalFilename,
      uploadedAt: paymentProofs.uploadedAt,
    })
    .from(paymentProofs)
    .where(eq(paymentProofs.gcashSubmissionId, submissionId))
    .orderBy(asc(paymentProofs.uploadedAt));

  return { ...row, payment: payment ?? null, proofs };
}

export async function getGcashSubmission(db: Db, submissionId: string): Promise<GcashSubmissionDetail> {
  return fetchSubmission(db, submissionId);
}

export interface GcashSubmissionPage {
  items: GcashSubmissionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** The verification queue: pending oldest first (first come, first served), others newest first. */
export async function listGcashSubmissions(db: Db, query: GcashSubmissionListQuery): Promise<GcashSubmissionPage> {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(gcashSubmissions.status, query.status));
  if (query.subscriberId) filters.push(eq(gcashSubmissions.subscriberId, query.subscriberId));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await db.select({ value: count() }).from(gcashSubmissions).where(where);
  const items = await db
    .select(listColumns)
    .from(gcashSubmissions)
    .innerJoin(subscribers, eq(subscribers.id, gcashSubmissions.subscriberId))
    .innerJoin(recorder, eq(recorder.id, gcashSubmissions.recordedByUserId))
    .where(where)
    .orderBy(query.status === "pending" ? asc(gcashSubmissions.recordedAt) : desc(gcashSubmissions.recordedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { items, total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize };
}
