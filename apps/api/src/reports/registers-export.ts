import {
  ADJUSTMENT_CATEGORY_LABELS,
  type AdjustmentCategory,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  SUBSCRIBER_STATUSES,
  SUBSCRIBER_STATUS_LABELS,
} from "@bcis/shared";
import type { ReportDocument } from "./document";
import type { ExceptionsRegister, MasterList } from "./registers";

export function buildMasterListDocument(list: MasterList, filters: { label: string; value: string }[]): ReportDocument {
  return {
    slug: "subscriber-master-list",
    title: "Subscriber Master List",
    period: `As of ${list.asOf}`,
    fileDate: list.asOf,
    filters,
    orientation: "landscape",
    figures: [
      { label: "Subscribers", value: list.totals.subscriberCount, kind: "count" },
      ...SUBSCRIBER_STATUSES.filter((st) => list.statusCounts[st] > 0).map((st) => ({
        label: SUBSCRIBER_STATUS_LABELS[st],
        value: list.statusCounts[st],
        kind: "count" as const,
      })),
      { label: "Active services", value: list.totals.activeServiceCount, kind: "count" },
      { label: "Monthly rates", value: list.totals.monthlyRateCentavos, kind: "money" },
    ],
    tables: [
      {
        columns: [
          { header: "Account", kind: "text", width: 1.1 },
          { header: "Name", kind: "text", width: 1.9 },
          { header: "Status", kind: "text" },
          { header: "Address", kind: "text", width: 2.6 },
          { header: "Contact", kind: "text", width: 1.3 },
          { header: "Area", kind: "text", width: 1.3 },
          { header: "Collector", kind: "text", width: 1.4 },
          { header: "Plans", kind: "text", width: 1.2 },
          { header: "Active svc", kind: "count", width: 0.8 },
          { header: "Monthly rate", kind: "money", width: 1.1 },
          { header: "Balance", kind: "money", width: 1.1 },
        ],
        rows: list.rows.map((r) => [
          r.accountNumber,
          r.fullName,
          SUBSCRIBER_STATUS_LABELS[r.status],
          r.address,
          r.contact,
          r.area,
          r.collector,
          r.plans,
          r.activeServiceCount,
          r.monthlyRateCentavos,
          r.balanceCentavos,
        ]),
        totals: [
          "Total",
          `${list.totals.subscriberCount} subscribers`,
          null,
          null,
          null,
          null,
          null,
          null,
          list.totals.activeServiceCount,
          list.totals.monthlyRateCentavos,
          list.totals.balanceCentavos,
        ],
        emptyMessage: "No subscribers match.",
      },
    ],
    notes: [
      "Monthly rate: current rates of active services. Balance: ledger balance today (negative is an advance credit). Archived subscribers are listed only when filtered by that status.",
    ],
  };
}

const methodLabel = (m: string) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m;
const categoryLabel = (c: string) => ADJUSTMENT_CATEGORY_LABELS[c as AdjustmentCategory] ?? c;

export function buildExceptionsDocument(register: ExceptionsRegister): ReportDocument {
  const t = register.totals;
  return {
    slug: "exceptions-register",
    title: "Adjustments, Reversals and Voids Register",
    period: `Made from ${register.from} to ${register.to}`,
    fileDate: `${register.from}_to_${register.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Debit adjustments", value: t.debitAdjustmentsCentavos, kind: "money" },
      { label: "Credit adjustments", value: t.creditAdjustmentsCentavos, kind: "money" },
      { label: "Reversed receipts", value: t.reversedCentavos, kind: "money" },
      { label: "Voided invoices", value: t.voidedCentavos, kind: "money" },
    ],
    tables: [
      {
        title: `Adjustments (${register.adjustments.length})`,
        columns: [
          { header: "Date", kind: "date", width: 1 },
          { header: "Adjustment", kind: "text", width: 1.1 },
          { header: "Invoice", kind: "text", width: 1.1 },
          { header: "Subscriber", kind: "text", width: 2 },
          { header: "Category", kind: "text", width: 1.3 },
          { header: "Amount", kind: "money", width: 1.1 },
          { header: "Reason", kind: "text", width: 2.4 },
          { header: "By", kind: "text", width: 1.3 },
        ],
        rows: register.adjustments.map((a) => [
          a.date,
          a.adjustmentNumber,
          a.invoiceNumber,
          `${a.accountNumber} ${a.subscriberName}`,
          `${a.kind === "credit" ? "Credit" : "Debit"}: ${categoryLabel(a.category)}`,
          a.amountCentavos,
          a.reason,
          a.by,
        ]),
        emptyMessage: "No adjustments in this period.",
      },
      {
        title: `Reversed receipts (${register.reversals.length})`,
        columns: [
          { header: "Reversed on", kind: "date", width: 1 },
          { header: "Receipt", kind: "text", width: 1.1 },
          { header: "Paid on", kind: "date", width: 1 },
          { header: "Subscriber", kind: "text", width: 2 },
          { header: "Method", kind: "text", width: 1 },
          { header: "Amount", kind: "money", width: 1.1 },
          { header: "Reason", kind: "text", width: 2.4 },
          { header: "By", kind: "text", width: 1.3 },
        ],
        rows: register.reversals.map((r) => [
          r.reversedOn,
          `${r.receiptNumber} (VOID)`,
          r.paymentDate,
          `${r.accountNumber} ${r.subscriberName}`,
          methodLabel(r.method),
          r.amountCentavos,
          r.reason,
          r.by,
        ]),
        totals: ["Total", null, null, null, null, t.reversedCentavos, null, null],
        emptyMessage: "No receipts were reversed in this period.",
      },
      {
        title: `Voided invoices (${register.voids.length})`,
        columns: [
          { header: "Voided on", kind: "date", width: 1 },
          { header: "Invoice", kind: "text", width: 1.1 },
          { header: "Month", kind: "text", width: 1 },
          { header: "Subscriber", kind: "text", width: 2 },
          { header: "Amount", kind: "money", width: 1.1 },
          { header: "Reason", kind: "text", width: 2.4 },
          { header: "By", kind: "text", width: 1.3 },
        ],
        rows: register.voids.map((v) => [
          v.voidedOn,
          v.invoiceNumber,
          v.period,
          `${v.accountNumber} ${v.subscriberName}`,
          v.amountCentavos,
          v.reason,
          v.by,
        ]),
        totals: ["Total", null, null, null, t.voidedCentavos, null, null],
        emptyMessage: "No invoices were voided in this period.",
      },
    ],
    notes: ["Each change is dated the day it was made. Adjustment amounts: debits positive, credits negative."],
  };
}
