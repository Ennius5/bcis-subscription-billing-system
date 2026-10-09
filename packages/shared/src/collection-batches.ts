import { z } from "zod";
import type { Centavos } from "./money";
import { MAX_PAYMENT_CENTAVOS } from "./payments";

/*
 * House-to-house collection batches (spec 3.8), as decided for this project:
 * - A batch is one collector's round on one date. When it is built, each subscriber on it
 *   gets a snapshot of current bill, arrears and total due: the route sheet and "expected".
 * - Every field collection is a real payment (receipt, oldest-first allocation, ledger),
 *   linked to the batch and collector. Collectors take cash or cheques; only cash is remitted.
 * - Remittances are append-only (a wrong one is voided). Reconciling compares remitted cash
 *   with collected cash; any difference is a shortage or overage that needs a reason.
 * - Closing is a separate, authorized step. Batches are never deleted, only cancelled while
 *   nothing has been collected.
 */

export const COLLECTION_BATCH_STATUSES = [
  "open",
  "in_progress",
  "submitted",
  "remitted",
  "reconciled",
  "closed",
  "cancelled",
] as const;
export type CollectionBatchStatus = (typeof COLLECTION_BATCH_STATUSES)[number];

export const COLLECTION_BATCH_STATUS_LABELS: Record<CollectionBatchStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  submitted: "Submitted",
  remitted: "Remitted",
  reconciled: "Reconciled",
  closed: "Closed",
  cancelled: "Cancelled",
};

// Same graph as the collection_batches_protect trigger (migration 0020).
const BATCH_TRANSITIONS: Record<CollectionBatchStatus, readonly CollectionBatchStatus[]> = {
  open: ["in_progress", "cancelled"], // dispatched, or called off
  in_progress: ["submitted", "cancelled"], // collector back; cancel only if nothing was collected
  submitted: ["remitted", "reconciled"], // reconciled directly when nothing was handed over
  remitted: ["reconciled"],
  reconciled: ["closed"],
  closed: [],
  cancelled: [],
};

export function allowedBatchTransitions(from: CollectionBatchStatus): readonly CollectionBatchStatus[] {
  return BATCH_TRANSITIONS[from];
}

/** Returns a user-facing message when the move is not allowed, or null when it is. */
export function batchTransitionProblem(from: CollectionBatchStatus, to: CollectionBatchStatus): string | null {
  if (from === to) return `The batch is already ${COLLECTION_BATCH_STATUS_LABELS[to].toLowerCase()}.`;
  if (!BATCH_TRANSITIONS[from].includes(to)) {
    return `A batch that is ${COLLECTION_BATCH_STATUS_LABELS[from].toLowerCase()} cannot be made ${COLLECTION_BATCH_STATUS_LABELS[to].toLowerCase()}.`;
  }
  return null;
}

/** Collections can be recorded only while the collector is out. */
export function canRecordCollections(status: CollectionBatchStatus): boolean {
  return status === "in_progress";
}

/** Remittances can be recorded or voided after submission and before reconciliation. */
export function canRecordRemittances(status: CollectionBatchStatus): boolean {
  return status === "submitted" || status === "remitted";
}

/* ------------------------------ Route sheet ------------------------------ */

export interface DueInvoice {
  dueDate: string;
  /** Effective total less paid; only open invoices are passed in. */
  openCentavos: Centavos;
}

export interface DueSnapshot {
  currentCentavos: Centavos;
  arrearsCentavos: Centavos;
  creditCentavos: Centavos;
  totalDueCentavos: Centavos;
}

/**
 * Splits what a subscriber owes for the route sheet. Current = not yet past due,
 * arrears = past due (due date before today, the same rule as "overdue"), and total due is
 * both less unapplied credit, never below zero. Dates are "YYYY-MM-DD", so they compare as text.
 */
export function dueSnapshot(invoices: readonly DueInvoice[], creditCentavos: Centavos, today: string): DueSnapshot {
  let currentCentavos = 0;
  let arrearsCentavos = 0;
  for (const invoice of invoices) {
    if (invoice.dueDate < today) arrearsCentavos += invoice.openCentavos;
    else currentCentavos += invoice.openCentavos;
  }
  return {
    currentCentavos,
    arrearsCentavos,
    creditCentavos,
    totalDueCentavos: Math.max(0, currentCentavos + arrearsCentavos - creditCentavos),
  };
}

/* ----------------------------- Reconciliation ----------------------------- */

export const VARIANCE_KINDS = ["balanced", "shortage", "overage"] as const;
export type VarianceKind = (typeof VARIANCE_KINDS)[number];

export const VARIANCE_KIND_LABELS: Record<VarianceKind, string> = {
  balanced: "Balanced",
  shortage: "Shortage",
  overage: "Overage",
};

/** AT-07/AT-08: difference = remitted cash - expected cash; below zero is a shortage. */
export function cashVariance(
  expectedCashCentavos: Centavos,
  remittedCashCentavos: Centavos,
): { differenceCentavos: Centavos; kind: VarianceKind } {
  const differenceCentavos = remittedCashCentavos - expectedCashCentavos;
  const kind: VarianceKind = differenceCentavos === 0 ? "balanced" : differenceCentavos < 0 ? "shortage" : "overage";
  return { differenceCentavos, kind };
}

/** What was expected on the batch and how much of it is still not collected (cash or not). */
export function uncollectedCentavos(
  expectedTotalDueCentavos: Centavos,
  cashCollectedCentavos: Centavos,
  nonCashCollectedCentavos: Centavos,
): Centavos {
  return Math.max(0, expectedTotalDueCentavos - cashCollectedCentavos - nonCashCollectedCentavos);
}

/* ------------------------------- Schemas ------------------------------- */

const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });
const amountCentavos = z
  .number()
  .int()
  .min(1, "Enter an amount greater than zero.")
  .max(MAX_PAYMENT_CENTAVOS, "That amount is too large.");
const notes = z.string().trim().max(500).nullish();
const requiredReason = z.string().trim().min(3, "A reason is required.").max(200);

/** The account list is built from the collector's subscribers, optionally one area only. */
export const batchCreateSchema = z.strictObject({
  collectorId: z.uuid({ message: "Choose a collector." }),
  collectionAreaId: z.uuid().nullish(),
  collectionDate: isoDate,
  notes,
});
export type BatchCreateInput = z.infer<typeof batchCreateSchema>;

/** Adding one subscriber by hand (open or in progress). */
export const batchAccountAddSchema = z.strictObject({ subscriberId: z.uuid() });
export type BatchAccountAddInput = z.infer<typeof batchAccountAddSchema>;

export const batchCancelSchema = z.strictObject({ reason: requiredReason });
export type BatchCancelInput = z.infer<typeof batchCancelSchema>;

export const FIELD_COLLECTION_METHODS = ["cash", "cheque"] as const;
export type FieldCollectionMethod = (typeof FIELD_COLLECTION_METHODS)[number];

/** A payment the collector took in the field, typed in from the collector's tally. */
export const fieldCollectionCreateSchema = z
  .strictObject({
    subscriberId: z.uuid(),
    method: z.enum(FIELD_COLLECTION_METHODS, { message: "Choose cash or cheque." }),
    amountCentavos,
    /** When the collector received it. Defaults to today; never in the future. */
    paymentDate: isoDate.optional(),
    /** Cheque number, or the collector's paper receipt number for cash. */
    referenceNumber: z.string().trim().max(60).nullish(),
    notes,
  })
  .refine((v) => v.method !== "cheque" || !!v.referenceNumber, {
    message: "Enter the cheque number.",
    path: ["referenceNumber"],
  });
export type FieldCollectionCreateInput = z.infer<typeof fieldCollectionCreateSchema>;

export const remittanceCreateSchema = z.strictObject({ amountCentavos, notes });
export type RemittanceCreateInput = z.infer<typeof remittanceCreateSchema>;

export const remittanceVoidSchema = z.strictObject({ reason: requiredReason });
export type RemittanceVoidInput = z.infer<typeof remittanceVoidSchema>;

/**
 * The reconciler confirms the difference they were shown. The server recomputes it and
 * refuses if it no longer matches, so nothing is reconciled on figures nobody saw.
 * A shortage or overage needs a reason (AT-08: never closed silently as balanced).
 */
export const batchReconcileSchema = z
  .strictObject({
    differenceCentavos: z.number().int(),
    varianceReason: z.string().trim().max(200).nullish(),
  })
  .refine((v) => v.differenceCentavos === 0 || (v.varianceReason?.length ?? 0) >= 3, {
    message: "Explain the shortage or overage.",
    path: ["varianceReason"],
  });
export type BatchReconcileInput = z.infer<typeof batchReconcileSchema>;

/**
 * Closing confirms the recorded difference again (spec: authorized confirmation before
 * closing). A batch reconciled with a shortage cannot be closed by someone who thinks it
 * balanced: the server refuses a difference that does not match the one recorded.
 */
export const batchCloseSchema = z.strictObject({ differenceCentavos: z.number().int() });
export type BatchCloseInput = z.infer<typeof batchCloseSchema>;

/* ---------------------------- Collector report ---------------------------- */

/**
 * Collection rate in basis points (8530 = 85.30%): what the collector brought in (cash and
 * cheques) against the total due on their route sheets. Null when nothing was due, so a
 * collector with no accounts is shown as "—" rather than 0% or 100%. Integer maths only.
 */
export function collectionRateBasisPoints(collectedCentavos: Centavos, expectedCentavos: Centavos): number | null {
  if (expectedCentavos <= 0) return null;
  return Math.round((collectedCentavos * 10_000) / expectedCentavos);
}

/** 8530 -> "85.3%", null -> "—". */
export function formatRate(basisPoints: number | null): string {
  if (basisPoints === null) return "—";
  return `${(basisPoints / 100).toFixed(1)}%`;
}

/** Batches whose collection date falls in the range, both ends inclusive. */
export const collectorReportQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { message: "The start date must be on or before the end date.", path: ["to"] });
export type CollectorReportQuery = z.infer<typeof collectorReportQuerySchema>;

export const BATCH_PAGE_SIZE_DEFAULT = 25;
export const BATCH_PAGE_SIZE_MAX = 100;

export const batchListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(BATCH_PAGE_SIZE_MAX).default(BATCH_PAGE_SIZE_DEFAULT),
    status: z.enum(COLLECTION_BATCH_STATUSES).optional(),
    collectorId: z.uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((r) => !r.from || !r.to || r.from <= r.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;
