import { useEffect, useState } from "react";
import { formatPesos, ledgerQuerySchema } from "@bcis/shared";
import type { SubscriberLedgerDto } from "../../../preload/index";
import { schemaErrors } from "../subscribers/ProfileForm";
import { RowError, Section } from "../subscribers/ProfileParts";
import { DateField } from "../ui/DateField";
import { ExportButtons } from "../ui/ExportButtons";

const ENTRY_LABELS: Record<string, string> = {
  invoice: "Invoice",
  invoice_void: "Invoice void",
  payment: "Payment",
  payment_reversal: "Payment reversal",
  adjustment: "Adjustment",
};

/** Positive balances are owed by the subscriber; a negative one is a credit in their favour. */
function balanceText(centavos: number): string {
  return centavos < 0 ? `${formatPesos(-centavos)} CR` : formatPesos(centavos);
}

const th = "sticky top-0 border-b border-slate-200 bg-slate-50 px-3 py-2 font-medium text-muted";

interface LedgerSectionProps {
  subscriberId: string;
  accountNumber: string;
  onSessionExpired: () => void;
}

/** The subscriber ledger (spec 3.5): every debit and credit in posting order, with a running balance. */
export function LedgerSection({ subscriberId, accountNumber, onSessionExpired }: LedgerSectionProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ledger, setLedger] = useState<SubscriberLedgerDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeErrors, setRangeErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    const parsed = ledgerQuerySchema.safeParse(range);
    if (!parsed.success) {
      setRangeErrors(schemaErrors(parsed.error));
      return;
    }
    setRangeErrors({});
    let cancelled = false;
    void window.bcis.billing.ledger(subscriberId, parsed.data).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setLedger(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") {
        onSessionExpired();
      } else {
        setError(r.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, from, to, onSessionExpired]);

  return (
    <Section
      title="Ledger"
      action={
        ledger && (
          <span className="text-sm">
            Balance <span className="money font-semibold">{balanceText(ledger.closingBalanceCentavos)}</span>
          </span>
        )
      }
    >
      <div className="mb-3 grid grid-cols-4 items-start gap-3">
        <DateField label="From" value={from} onChange={setFrom} error={rangeErrors.from} hint="Blank for the beginning." />
        <DateField label="To" value={to} onChange={setTo} error={rangeErrors.to} hint="Blank for today." />
        <div className="col-span-2 flex flex-col items-end gap-1">
          <span className="text-xs text-muted">Statement of Account for this range, with unpaid bills and aging</span>
          <ExportButtons
            onExport={(format) =>
              window.bcis.billing.exportStatement(
                subscriberId,
                { ...(from ? { from } : {}), ...(to ? { to } : {}) },
                format,
                accountNumber,
              )
            }
            onExpired={onSessionExpired}
            disabled={!ledger || Object.keys(rangeErrors).length > 0}
          />
        </div>
      </div>

      {error && <RowError message={`Could not load the ledger. ${error}`} />}
      {!ledger && !error && <p className="text-sm text-muted">Loading…</p>}

      {ledger && (
        <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={`${th} text-left`}>Date</th>
                <th scope="col" className={`${th} text-left`}>Reference</th>
                <th scope="col" className={`${th} text-left`}>Description</th>
                <th scope="col" className={`${th} text-right`}>Debit</th>
                <th scope="col" className={`${th} text-right`}>Credit</th>
                <th scope="col" className={`${th} text-right`}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.from && (
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <td className="px-3 py-2 text-muted">{ledger.from}</td>
                  <td className="px-3 py-2" colSpan={4}>
                    <span className="text-muted">Opening balance</span>
                  </td>
                  <td className="money px-3 py-2">{balanceText(ledger.openingBalanceCentavos)}</td>
                </tr>
              )}
              {ledger.entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted">
                    No ledger entries{ledger.from || ledger.to ? " in this range" : " yet"}.
                  </td>
                </tr>
              ) : (
                ledger.entries.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2">{e.entryDate}</td>
                    <td className="px-3 py-2 font-medium">{e.reference}</td>
                    <td className="px-3 py-2">
                      {e.description}
                      <span className="block text-xs text-muted">{ENTRY_LABELS[e.entryType] ?? e.entryType}</span>
                    </td>
                    <td className="money px-3 py-2">{e.debitCentavos ? formatPesos(e.debitCentavos) : ""}</td>
                    <td className="money px-3 py-2">{e.creditCentavos ? formatPesos(e.creditCentavos) : ""}</td>
                    <td className="money px-3 py-2">{balanceText(e.balanceCentavos)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-2" colSpan={3}>
                  Totals
                </td>
                <td className="money px-3 py-2">{formatPesos(ledger.totalDebitCentavos)}</td>
                <td className="money px-3 py-2">{formatPesos(ledger.totalCreditCentavos)}</td>
                <td className="money px-3 py-2">{balanceText(ledger.closingBalanceCentavos)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Section>
  );
}
