import { z } from "zod";
import { contactValueProblem } from "./subscribers";

/*
 * Payment rules (Phase 5), as decided for this project:
 * - A posted payment gets an RCPT- number and one ledger credit for its full amount.
 * - It pays the subscriber's open invoices oldest-first (earliest due date, then invoice
 *   number), across all their services. Choosing invoices by hand needs payment.allocate.
 * - Whatever is left is the subscriber's credit (advance payment). It stays on the payment
 *   and is applied oldest-first to invoices finalized later. No value is lost (AT-03).
 * - GCash is recorded as a submission and becomes a payment only when verified (spec 3.7).
 * - Mistakes are reversed, never edited or deleted; a reversed receipt keeps its number.
 */

export const PAYMENT_METHODS = ["cash", "gcash", "bank_transfer", "cheque", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods posted directly at the counter. GCash goes through verification instead. */
export const COUNTER_PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "other"] as const;
export type CounterPaymentMethod = (typeof COUNTER_PAYMENT_METHODS)[number];

/** Methods whose reference number is required (bank reference, cheque number). */
export const METHODS_REQUIRING_REFERENCE: readonly PaymentMethod[] = ["gcash", "bank_transfer", "cheque"];

export const PAYMENT_STATUSES = ["posted", "reversed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ALLOCATION_SOURCES = ["auto", "manual", "credit"] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];

export const GCASH_SUBMISSION_STATUSES = ["pending", "verified", "rejected", "reversed"] as const;
export type GcashSubmissionStatus = (typeof GCASH_SUBMISSION_STATUSES)[number];

/** ₱1,000,000.00. Far above any real payment here; it only stops typing mistakes. */
export const MAX_PAYMENT_CENTAVOS = 100_000_000;

/* ------------------------------ GCash refs ------------------------------ */

/**
 * The form a GCash reference is stored and compared in: spaces removed, upper case.
 * "1012 345 678901" and "1012345678901" are the same reference (AT-05).
 */
export function normalizeGcashReference(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

const GCASH_REFERENCE_PATTERN = /^[0-9A-Z]{6,30}$/;

/* ------------------------------ Proof files ------------------------------ */

export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ProofMimeType = (typeof PROOF_MIME_TYPES)[number];

/**
 * The file's real type, read from its first bytes ("magic numbers"), never from its name
 * or the type the client claims. Returns null for anything that is not PNG, JPEG or WebP.
 */
export function detectProofType(bytes: Uint8Array): ProofMimeType | null {
  const starts = (sig: readonly number[], offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF" <4-byte size> "WEBP"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
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

/** One invoice and how much of the payment goes to it. Only with payment.allocate. */
export const manualAllocationSchema = z.strictObject({
  invoiceId: z.uuid(),
  amountCentavos,
});
export type ManualAllocationInput = z.infer<typeof manualAllocationSchema>;

/** Receive Payment at the counter: Cash, bank transfer, cheque or other. */
export const paymentCreateSchema = z
  .strictObject({
    subscriberId: z.uuid(),
    method: z.enum(COUNTER_PAYMENT_METHODS, { message: "Choose a payment method." }),
    amountCentavos,
    /** Defaults to today on the server; never in the future (checked by the service). */
    paymentDate: isoDate.optional(),
    referenceNumber: z.string().trim().max(60).nullish(),
    notes,
    /** Omitted means oldest-first. Any amount not listed becomes credit. */
    allocations: z.array(manualAllocationSchema).min(1).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    if (METHODS_REQUIRING_REFERENCE.includes(v.method) && !v.referenceNumber) {
      ctx.addIssue({
        code: "custom",
        message: v.method === "cheque" ? "Enter the cheque number." : "Enter the bank reference number.",
        path: ["referenceNumber"],
      });
    }
    if (v.allocations) {
      const total = v.allocations.reduce((sum, a) => sum + a.amountCentavos, 0);
      if (total > v.amountCentavos) {
        ctx.addIssue({
          code: "custom",
          message: "The amounts applied to invoices are more than the payment.",
          path: ["allocations"],
        });
      }
      const ids = v.allocations.map((a) => a.invoiceId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: "An invoice is listed twice.", path: ["allocations"] });
      }
    }
  });
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const paymentReverseSchema = z.strictObject({ reason: requiredReason });
export type PaymentReverseInput = z.infer<typeof paymentReverseSchema>;

/** What staff type in from the customer's Facebook message (spec 3.7 step 2). */
export const gcashSubmissionCreateSchema = z.strictObject({
  subscriberId: z.uuid(),
  referenceNumber: z
    .string()
    .transform(normalizeGcashReference)
    .pipe(z.string().regex(GCASH_REFERENCE_PATTERN, "Enter the GCash reference number (letters and digits).")),
  senderName: z.string().trim().min(2, "Enter the sender's name.").max(120),
  senderNumber: z
    .string()
    .trim()
    .max(30)
    .superRefine((value, ctx) => {
      const problem = contactValueProblem("mobile", value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  amountCentavos,
  transactionDate: isoDate,
  notes,
});
export type GcashSubmissionCreateInput = z.infer<typeof gcashSubmissionCreateSchema>;

export const gcashRejectSchema = z.strictObject({ reason: requiredReason });
export type GcashRejectInput = z.infer<typeof gcashRejectSchema>;

/** Maximum proof images on one GCash submission. */
export const GCASH_PROOFS_MAX = 5;

export const GCASH_PAGE_SIZE_DEFAULT = 25;
export const GCASH_PAGE_SIZE_MAX = 100;

/** The GCash Verification queue. Query-string values arrive as text, so numbers are coerced. */
export const gcashSubmissionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(GCASH_PAGE_SIZE_MAX).default(GCASH_PAGE_SIZE_DEFAULT),
  status: z.enum(GCASH_SUBMISSION_STATUSES).optional(),
  subscriberId: z.uuid().optional(),
});
export type GcashSubmissionListQuery = z.infer<typeof gcashSubmissionListQuerySchema>;

export const PAYMENT_PAGE_SIZE_DEFAULT = 25;
export const PAYMENT_PAGE_SIZE_MAX = 100;

/** Payment History filters. Dates are inclusive payment dates; a blank search is no search. */
export const paymentListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(PAYMENT_PAGE_SIZE_MAX).default(PAYMENT_PAGE_SIZE_DEFAULT),
    subscriberId: z.uuid().optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((s) => (s === "" ? undefined : s)),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
