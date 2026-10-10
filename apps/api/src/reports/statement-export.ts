import { AGING_BUCKETS, AGING_BUCKET_LABELS, formatPesos } from "@bcis/shared";
import type { ReportDocument } from "./document";
import type { StatementOfAccount } from "./statement";

/** The Statement of Account as a printable document: activity with running balance, unpaid bills, aging. */
export function buildStatementDocument(soa: StatementOfAccount): ReportDocument {
  const { ledger, subscriber } = soa;
  const amountDue = ledger.closingBalanceCentavos;
  return {
    slug: `soa-${subscriber.accountNumber}`,
    title: "Statement of Account",
    period: ledger.from ? `Statement period ${ledger.from} to ${soa.asOf}` : `All account activity up to ${soa.asOf}`,
    fileDate: soa.asOf,
    filters: [
      { label: "Account", value: subscriber.accountNumber },
      { label: "Name", value: subscriber.fullName },
      ...(subscriber.address ? [{ label: "Address", value: subscriber.address }] : []),
      ...(subscriber.area ? [{ label: "Area", value: subscriber.area }] : []),
    ],
    figures: [
      { label: "Opening balance", value: ledger.openingBalanceCentavos, kind: "money" },
      { label: "Charges", value: ledger.totalDebitCentavos, kind: "money" },
      { label: "Payments and credits", value: ledger.totalCreditCentavos, kind: "money" },
      { label: amountDue < 0 ? "Credit balance" : "Amount due", value: Math.abs(amountDue), kind: "money" },
    ],
    tables: [
      {
        title: "Account activity",
        columns: [
          { header: "Date", kind: "date", width: 1.1 },
          { header: "Reference", kind: "text", width: 1.3 },
          { header: "Description", kind: "text", width: 3.4 },
          { header: "Charges", kind: "money", width: 1.2 },
          { header: "Payments / credits", kind: "money", width: 1.3 },
          { header: "Balance", kind: "money", width: 1.2 },
        ],
        rows: [
          [ledger.from ?? "", "", "Opening balance", null, null, ledger.openingBalanceCentavos],
          ...ledger.entries.map((e) => [
            e.entryDate,
            e.reference,
            e.description,
            e.debitCentavos || null,
            e.creditCentavos || null,
            e.balanceCentavos,
          ]),
        ],
        totals: ["", "", "Closing balance", ledger.totalDebitCentavos, ledger.totalCreditCentavos, ledger.closingBalanceCentavos],
      },
      {
        title: `Unpaid invoices as of ${soa.asOf}`,
        columns: [
          { header: "Invoice", kind: "text", width: 1.2 },
          { header: "Service", kind: "text", width: 1.1 },
          { header: "Month", kind: "text", width: 1.4 },
          { header: "Due date", kind: "date", width: 1.1 },
          { header: "Days past due", kind: "count" },
          { header: "Amount", kind: "money", width: 1.1 },
          { header: "Paid", kind: "money", width: 1.1 },
          { header: "Balance", kind: "money", width: 1.1 },
        ],
        rows: soa.openInvoices.map((i) => [
          i.invoiceNumber,
          i.serviceNumber,
          i.periodLabel,
          i.dueDate,
          i.daysPastDue,
          i.amountCentavos,
          i.paidCentavos,
          i.openCentavos,
        ]),
        totals: ["Total", "", "", "", null, null, null, soa.openInvoicesCentavos],
        emptyMessage: "No unpaid invoices.",
      },
      {
        title: "Aging of unpaid invoices",
        columns: [
          ...AGING_BUCKETS.map((b) => ({ header: AGING_BUCKET_LABELS[b], kind: "money" as const })),
          { header: "Total", kind: "money" },
        ],
        rows: [[...AGING_BUCKETS.map((b) => soa.aging[b]), soa.openInvoicesCentavos]],
      },
    ],
    notes: [
      ...(soa.unappliedCreditCentavos > 0
        ? [`Advance payments not yet applied to an invoice: ${formatPesos(soa.unappliedCreditCentavos)}. They are applied to the next bills.`]
        : []),
      ...(soa.reconciles
        ? []
        : ["WARNING: the unpaid invoices less unapplied credit do not equal the closing balance. Please refer this statement to the administrator."]),
      "Please present this statement when paying. Payments made after the statement date are not shown.",
    ],
  };
}
