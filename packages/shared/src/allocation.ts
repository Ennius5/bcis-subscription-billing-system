import { assertCentavos, formatPesos, type Centavos } from "./money";

/*
 * Payment allocation (spec 3.6), as pure functions so the API (posting) and the desktop
 * (the allocation preview on Receive Payment) always agree. No database here: the caller
 * passes the subscriber's open invoices and gets back how the money splits.
 *
 * Every plan keeps all of the money: sum(lines) + credit = amount. Nothing is lost (AT-03).
 */

/** An invoice that can still take money: finalized, not void, balance > 0. */
export interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  dueDate: string; // YYYY-MM-DD
  balanceCentavos: Centavos;
}

export interface AllocationLine {
  invoiceId: string;
  invoiceNumber: string;
  balanceBeforeCentavos: Centavos;
  amountCentavos: Centavos;
  balanceAfterCentavos: Centavos;
}

export interface AllocationPlan {
  lines: AllocationLine[];
  /** What is left after the invoices: the subscriber's credit (advance payment). */
  creditCentavos: Centavos;
}

export type InvoicePaymentStatus = "unpaid" | "partially_paid" | "paid" | "credited";

/**
 * The stored status for a finalized invoice. Mirrors the invoices_paid_status_consistent check.
 * The effective total is the billed total plus the net of its adjustments (negative for credits).
 * CREDITED: credit adjustments brought the effective total to zero, so nothing was paid.
 */
export function invoicePaymentStatus(
  totalCentavos: Centavos,
  paidCentavos: Centavos,
  adjustedCentavos: Centavos = 0,
): InvoicePaymentStatus {
  assertCentavos(totalCentavos, "total");
  assertCentavos(paidCentavos, "paid");
  assertCentavos(adjustedCentavos, "adjusted");
  const effective = totalCentavos + adjustedCentavos;
  if (effective < 0) throw new RangeError(`credits (${-adjustedCentavos}) exceed the total (${totalCentavos})`);
  if (paidCentavos < 0 || paidCentavos > effective) {
    throw new RangeError(`paid (${paidCentavos}) must be between 0 and the effective total (${effective})`);
  }
  if (effective === 0 && adjustedCentavos < 0) return "credited";
  if (paidCentavos === effective) return "paid";
  return paidCentavos === 0 ? "unpaid" : "partially_paid";
}

/** Oldest first: earliest due date, then lowest invoice number (INV- numbers are zero-padded). */
export function compareOldestFirst(a: OpenInvoice, b: OpenInvoice): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.invoiceNumber !== b.invoiceNumber) return a.invoiceNumber < b.invoiceNumber ? -1 : 1;
  return 0;
}

function assertPositiveAmount(amountCentavos: Centavos): void {
  assertCentavos(amountCentavos, "payment amount");
  if (amountCentavos <= 0) throw new RangeError(`payment amount must be positive, got ${amountCentavos}`);
}

function openOnly(invoices: readonly OpenInvoice[]): OpenInvoice[] {
  for (const invoice of invoices) assertCentavos(invoice.balanceCentavos, `balance of ${invoice.invoiceNumber}`);
  return invoices.filter((invoice) => invoice.balanceCentavos > 0).toSorted(compareOldestFirst);
}

function line(invoice: OpenInvoice, amountCentavos: Centavos): AllocationLine {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    balanceBeforeCentavos: invoice.balanceCentavos,
    amountCentavos,
    balanceAfterCentavos: invoice.balanceCentavos - amountCentavos,
  };
}

/**
 * The default rule: pay the oldest invoice in full, then the next, until the money runs
 * out. Whatever remains after every invoice is paid becomes credit.
 * Also used to apply existing credit to newly finalized invoices.
 */
export function allocateOldestFirst(amountCentavos: Centavos, invoices: readonly OpenInvoice[]): AllocationPlan {
  assertPositiveAmount(amountCentavos);
  const lines: AllocationLine[] = [];
  let remaining = amountCentavos;
  for (const invoice of openOnly(invoices)) {
    if (remaining === 0) break;
    const applied = Math.min(remaining, invoice.balanceCentavos);
    lines.push(line(invoice, applied));
    remaining -= applied;
  }
  return { lines, creditCentavos: remaining };
}

export interface ManualAllocationRequest {
  invoiceId: string;
  amountCentavos: Centavos;
}

export type ManualAllocationResult =
  | { ok: true; plan: AllocationPlan }
  | { ok: false; problem: string; invoiceId?: string };

/**
 * Manual allocation (payment.allocate only): the user says which invoices get how much.
 * Each must be one of the subscriber's open invoices and no more than its balance; the
 * total cannot exceed the payment. Anything not assigned becomes credit.
 */
export function planManualAllocation(
  amountCentavos: Centavos,
  requests: readonly ManualAllocationRequest[],
  invoices: readonly OpenInvoice[],
): ManualAllocationResult {
  assertPositiveAmount(amountCentavos);
  const open = new Map(openOnly(invoices).map((invoice) => [invoice.id, invoice]));
  const seen = new Set<string>();
  const lines: AllocationLine[] = [];
  let total = 0;

  for (const request of requests) {
    assertCentavos(request.amountCentavos, "allocation amount");
    if (seen.has(request.invoiceId)) {
      return { ok: false, problem: "An invoice is listed twice.", invoiceId: request.invoiceId };
    }
    seen.add(request.invoiceId);
    const invoice = open.get(request.invoiceId);
    if (!invoice) {
      return {
        ok: false,
        problem: "That invoice is not an open invoice of this subscriber.",
        invoiceId: request.invoiceId,
      };
    }
    if (request.amountCentavos <= 0) {
      return { ok: false, problem: `Enter an amount for ${invoice.invoiceNumber}.`, invoiceId: invoice.id };
    }
    if (request.amountCentavos > invoice.balanceCentavos) {
      return {
        ok: false,
        problem: `${invoice.invoiceNumber} only has a balance of ${formatPesos(invoice.balanceCentavos)}.`,
        invoiceId: invoice.id,
      };
    }
    lines.push(line(invoice, request.amountCentavos));
    total += request.amountCentavos;
  }

  if (total > amountCentavos) {
    return { ok: false, problem: "The amounts applied to invoices are more than the payment." };
  }
  const sorted = lines.toSorted((a, b) => compareOldestFirst(open.get(a.invoiceId)!, open.get(b.invoiceId)!));
  return { ok: true, plan: { lines: sorted, creditCentavos: amountCentavos - total } };
}
