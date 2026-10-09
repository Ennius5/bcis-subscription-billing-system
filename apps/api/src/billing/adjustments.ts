import { eq } from "drizzle-orm";
import {
  ADJUSTMENT_CATEGORY_LABELS,
  adjustmentProblem,
  invoicePaymentStatus,
  type AdjustmentCreateInput,
} from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { takeDocumentNumbers } from "../db/document-numbers";
import { dbToday } from "../db/query_helpers";
import { adjustments, invoices, ledgerEntries, subscribers } from "../db/schema";
import { applyAvailableCredit } from "../payments/service";
import { BillingError, fetchInvoice, type InvoiceDetail } from "./service";

/**
 * Posts a debit or credit adjustment to a finalized invoice (spec 3.4). In one transaction:
 * takes the next ADJ- number, records the adjustment, moves the invoice's adjusted amount and
 * status, and posts the matching ledger line. A debit can reopen a paid invoice, so any credit
 * the subscriber has is applied afterwards, as after a reversal.
 */
export async function createAdjustment(
  db: Db,
  actorUserId: string,
  invoiceId: string,
  input: AdjustmentCreateInput,
): Promise<InvoiceDetail> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ subscriberId: invoices.subscriberId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    if (!found) throw new BillingError("INVOICE_NOT_FOUND", 404, "Invoice not found.");
    // Same lock order as every money operation: the subscriber first, then their invoice.
    await tx
      .select({ id: subscribers.id })
      .from(subscribers)
      .where(eq(subscribers.id, found.subscriberId))
      .for("update");

    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!invoice) throw new BillingError("INVOICE_NOT_FOUND", 404, "Invoice not found.");
    if (invoice.status === "draft") {
      throw new BillingError("INVOICE_IS_DRAFT", 409, "Drafts cannot be adjusted; change the account and generate again.");
    }
    if (invoice.status === "void") {
      throw new BillingError("INVOICE_IS_VOID", 409, `Invoice ${invoice.invoiceNumber} is void and cannot be adjusted.`);
    }

    const openBalance = invoice.totalCentavos + invoice.adjustedCentavos - invoice.paidCentavos;
    const problem = adjustmentProblem(input.kind, input.amountCentavos, openBalance);
    if (problem) throw new BillingError("ADJUSTMENT_NOT_ALLOWED", 422, problem);

    const [adjustmentNumber] = await takeDocumentNumbers(tx, "adjustment", 1);
    const [row] = await tx
      .insert(adjustments)
      .values({
        adjustmentNumber: adjustmentNumber!,
        invoiceId,
        subscriberId: invoice.subscriberId,
        kind: input.kind,
        category: input.category,
        amountCentavos: input.amountCentavos,
        reason: input.reason,
        createdByUserId: actorUserId,
      })
      .returning({ id: adjustments.id });

    const signed = input.kind === "debit" ? input.amountCentavos : -input.amountCentavos;
    const adjusted = invoice.adjustedCentavos + signed;
    const status = invoicePaymentStatus(invoice.totalCentavos, invoice.paidCentavos, adjusted);
    await tx.update(invoices).set({ adjustedCentavos: adjusted, status }).where(eq(invoices.id, invoiceId));

    const label = ADJUSTMENT_CATEGORY_LABELS[input.category];
    await tx.insert(ledgerEntries).values({
      subscriberId: invoice.subscriberId,
      serviceAccountId: invoice.serviceAccountId,
      entryDate: await dbToday(tx),
      entryType: "adjustment",
      reference: adjustmentNumber!,
      description: `${input.kind === "credit" ? "Credit" : "Debit"}: ${label} on ${invoice.invoiceNumber} (${input.reason})`,
      ...(input.kind === "debit" ? { debitCentavos: input.amountCentavos } : { creditCentavos: input.amountCentavos }),
      invoiceId,
      adjustmentId: row!.id,
      createdByUserId: actorUserId,
    });

    await writeAudit(tx, {
      actorUserId,
      action: "invoice.adjust",
      entityType: "invoice",
      entityId: invoiceId,
      reason: input.reason,
      oldValues: { adjustedCentavos: invoice.adjustedCentavos, status: invoice.status },
      newValues: {
        adjustmentNumber,
        invoiceNumber: invoice.invoiceNumber,
        kind: input.kind,
        category: input.category,
        amountCentavos: input.amountCentavos,
        adjustedCentavos: adjusted,
        status,
      },
    });

    if (input.kind === "debit") await applyAvailableCredit(tx, actorUserId, invoice.subscriberId);
    return fetchInvoice(tx, invoiceId);
  });
}
