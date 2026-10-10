import { useEffect, useState } from "react";
import {
  ADJUSTMENT_CATEGORY_LABELS,
  type AdjustmentCategory,
  exceptionsQuerySchema,
  formatPesos,
} from "@bcis/shared";
import type {
  DateRangeQuery,
  ExceptionAdjustmentDto,
  ExceptionReversalDto,
  ExceptionVoidDto,
  ExceptionsRegisterDto,
} from "../../../preload/index";
import { methodLabel, todayLocal } from "../payments/paymentLabels";
import { MoneyTile } from "../receivables/receivableParts";
import { RowError } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { ExportButtons } from "../ui/ExportButtons";

const firstOfMonth = () => `${todayLocal().slice(0, 8)}01`;
const who = (r: { accountNumber: string; subscriberName: string }) => (
  <>
    <span className="font-medium">{r.subscriberName}</span>
    <span className="block text-xs text-muted">{r.accountNumber}</span>
  </>
);

interface ExceptionsScreenProps {
  canExport: boolean;
  onSessionExpired: () => void;
}

/**
 * Every change to posted money in a date range, dated the day it was made: adjustments,
 * reversed receipts and voided invoices, each with who did it and why.
 */
export function ExceptionsScreen({ canExport, onSessionExpired }: ExceptionsScreenProps) {
  const [query, setQuery] = useState<DateRangeQuery>({ from: firstOfMonth(), to: todayLocal() });
  const [register, setRegister] = useState<ExceptionsRegisterDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = exceptionsQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the dates.");

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    void window.bcis.reports.exceptions(query).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setRegister(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [query, queryProblem, onSessionExpired]);

  const adjustmentColumns: Column<ExceptionAdjustmentDto>[] = [
    { key: "date", header: "Date", render: (a) => a.date },
    { key: "number", header: "Adjustment", render: (a) => a.adjustmentNumber },
    { key: "invoice", header: "Invoice", render: (a) => a.invoiceNumber },
    { key: "who", header: "Subscriber", render: who },
    {
      key: "category",
      header: "Category",
      render: (a) =>
        `${a.kind === "credit" ? "Credit" : "Debit"}: ${ADJUSTMENT_CATEGORY_LABELS[a.category as AdjustmentCategory] ?? a.category}`,
    },
    { key: "amount", header: "Amount", align: "right", render: (a) => formatPesos(a.amountCentavos) },
    { key: "reason", header: "Reason", render: (a) => a.reason },
    { key: "by", header: "By", render: (a) => a.by },
  ];

  const reversalColumns: Column<ExceptionReversalDto>[] = [
    { key: "on", header: "Reversed on", render: (r) => r.reversedOn },
    {
      key: "receipt",
      header: "Receipt",
      render: (r) => (
        <>
          {r.receiptNumber} <span className="text-xs font-semibold text-danger">VOID</span>
        </>
      ),
    },
    { key: "paid", header: "Paid on", render: (r) => r.paymentDate },
    { key: "who", header: "Subscriber", render: who },
    { key: "method", header: "Method", render: (r) => methodLabel(r.method) },
    { key: "amount", header: "Amount", align: "right", render: (r) => formatPesos(r.amountCentavos) },
    { key: "reason", header: "Reason", render: (r) => r.reason },
    { key: "by", header: "By", render: (r) => r.by },
  ];

  const voidColumns: Column<ExceptionVoidDto>[] = [
    { key: "on", header: "Voided on", render: (v) => v.voidedOn },
    { key: "invoice", header: "Invoice", render: (v) => v.invoiceNumber },
    { key: "month", header: "Month", render: (v) => v.period },
    { key: "who", header: "Subscriber", render: who },
    { key: "amount", header: "Amount", align: "right", render: (v) => formatPesos(v.amountCentavos) },
    { key: "reason", header: "Reason", render: (v) => v.reason },
    { key: "by", header: "By", render: (v) => v.by },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="w-44">
            <DateField label="Made from" value={query.from} onChange={(from) => setQuery({ ...query, from })} required />
          </div>
          <div className="w-44">
            <DateField label="Made to" value={query.to} onChange={(to) => setQuery({ ...query, to })} required />
          </div>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportExceptions(query, format)}
            onExpired={onSessionExpired}
            disabled={queryProblem !== null || !register}
          />
        )}
      </div>

      {queryProblem && <RowError message={queryProblem} />}
      {error && <RowError message={`Could not load the register. ${error}`} />}
      {!register && !error && !queryProblem && <p className="text-muted">Loading…</p>}

      {register && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <MoneyTile label="Debit adjustments" centavos={register.totals.debitAdjustmentsCentavos} />
            <MoneyTile label="Credit adjustments" centavos={register.totals.creditAdjustmentsCentavos} />
            <MoneyTile
              label="Reversed receipts"
              centavos={register.totals.reversedCentavos}
              note={`${register.reversals.length} receipt${register.reversals.length === 1 ? "" : "s"}`}
            />
            <MoneyTile
              label="Voided invoices"
              centavos={register.totals.voidedCentavos}
              note={`${register.voids.length} invoice${register.voids.length === 1 ? "" : "s"}`}
            />
          </div>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">Adjustments ({register.adjustments.length})</h2>
            <DataTable
              columns={adjustmentColumns}
              rows={register.adjustments}
              getRowKey={(a) => a.adjustmentNumber}
              emptyMessage="No adjustments in this period."
            />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">Reversed receipts ({register.reversals.length})</h2>
            <DataTable
              columns={reversalColumns}
              rows={register.reversals}
              getRowKey={(r) => r.receiptNumber}
              emptyMessage="No receipts were reversed in this period."
            />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">Voided invoices ({register.voids.length})</h2>
            <DataTable
              columns={voidColumns}
              rows={register.voids}
              getRowKey={(v) => v.invoiceNumber}
              emptyMessage="No invoices were voided in this period."
            />
          </section>
          <p className="text-xs text-muted">Each change is dated the day it was made. Adjustments: debits positive, credits negative.</p>
        </>
      )}
    </div>
  );
}
