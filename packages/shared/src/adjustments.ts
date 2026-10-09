import { z } from "zod";
import { formatPesos, type Centavos } from "./money";
import { MAX_PAYMENT_CENTAVOS } from "./payments";

/*
 * Invoice adjustments (spec 3.4 "controlled adjustment"), as decided for this project:
 * - Always against one finalized, non-void invoice. A credit lowers what is owed on it, a
 *   debit adds to it. The invoice's billed lines never change.
 * - A credit cannot exceed the invoice's open balance: money already paid is never credited
 *   away (reverse the payment instead). A debit has no cap.
 * - CREDITED means credits brought the invoice to zero with nothing paid.
 * - Adjustments are never edited; a mistake is corrected by the opposite adjustment.
 */

export const ADJUSTMENT_KINDS = ["credit", "debit"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export const CREDIT_CATEGORIES = ["discount", "service_outage", "billing_error", "goodwill", "other"] as const;
export const DEBIT_CATEGORIES = ["penalty", "reconnection_fee", "billing_error", "other"] as const;
export const ADJUSTMENT_CATEGORIES = [
  "discount",
  "service_outage",
  "billing_error",
  "goodwill",
  "penalty",
  "reconnection_fee",
  "other",
] as const;
export type AdjustmentCategory = (typeof ADJUSTMENT_CATEGORIES)[number];

export const ADJUSTMENT_CATEGORY_LABELS: Record<AdjustmentCategory, string> = {
  discount: "Discount",
  service_outage: "Service outage rebate",
  billing_error: "Billing error",
  goodwill: "Goodwill",
  penalty: "Penalty",
  reconnection_fee: "Reconnection fee",
  other: "Other",
};

export function categoriesFor(kind: AdjustmentKind): readonly AdjustmentCategory[] {
  return kind === "credit" ? CREDIT_CATEGORIES : DEBIT_CATEGORIES;
}

/** Returns a user-facing message when the adjustment is not allowed, or null when it is. */
export function adjustmentProblem(
  kind: AdjustmentKind,
  amountCentavos: Centavos,
  openBalanceCentavos: Centavos,
): string | null {
  if (kind === "credit" && amountCentavos > openBalanceCentavos) {
    return openBalanceCentavos === 0
      ? "Nothing is owed on this invoice, so it cannot be credited. Reverse a payment first if money must be returned."
      : `A credit cannot be more than the open balance of ${formatPesos(openBalanceCentavos)}.`;
  }
  return null;
}

export const adjustmentCreateSchema = z
  .strictObject({
    kind: z.enum(ADJUSTMENT_KINDS, { message: "Choose credit or debit." }),
    category: z.enum(ADJUSTMENT_CATEGORIES, { message: "Choose a category." }),
    amountCentavos: z
      .number()
      .int()
      .min(1, "Enter an amount greater than zero.")
      .max(MAX_PAYMENT_CENTAVOS, "That amount is too large."),
    reason: z.string().trim().min(3, "A reason is required.").max(200),
  })
  .refine((v) => (categoriesFor(v.kind) as readonly string[]).includes(v.category), {
    message: "That category does not apply to this kind of adjustment.",
    path: ["category"],
  });
export type AdjustmentCreateInput = z.infer<typeof adjustmentCreateSchema>;
