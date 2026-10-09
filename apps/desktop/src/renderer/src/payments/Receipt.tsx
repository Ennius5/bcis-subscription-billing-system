import { formatPesos, periodLabel, periodOf } from "@bcis/shared";
import type { PaymentDetailDto } from "../../../preload/index";
import { formatDateTime } from "../subscribers/ProfileParts";
import { methodLabel } from "./paymentLabels";

interface ReceiptProps {
  payment: PaymentDetailDto;
  /** True whenever this is not the first print right after posting (decision: reprints say so). */
  reprint: boolean;
}

/**
 * The payment receipt (spec 3.11). `print-area` makes it the only thing on the page when
 * printed (see styles.css). A reversed payment still shows, marked VOID, with its number.
 */
export function Receipt({ payment, reprint }: ReceiptProps) {
  const reversed = payment.status === "reversed";
  return (
    <article className="print-area relative mx-auto max-w-md rounded-lg border border-slate-200 bg-surface p-6 text-sm text-ink">
      {reversed && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-bold tracking-widest text-danger/20"
        >
          VOID
        </div>
      )}

      <header className="border-b border-slate-200 pb-3 text-center">
        <div className="font-semibold text-navy">Bukidnon Cable and Internet Services</div>
        <div className="mt-1 text-xs uppercase tracking-wide text-muted">Payment Receipt</div>
        {reprint && <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-warning">Reprint</div>}
        {reversed && <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-danger">Void: payment reversed</div>}
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted">Receipt no.</dt>
        <dd className="text-right font-semibold">{payment.receiptNumber}</dd>
        <dt className="text-muted">Payment date</dt>
        <dd className="text-right">{payment.paymentDate}</dd>
        <dt className="text-muted">Posted</dt>
        <dd className="text-right">{formatDateTime(payment.postedAt)}</dd>
        <dt className="text-muted">Account</dt>
        <dd className="text-right">{payment.accountNumber}</dd>
        <dt className="text-muted">Name</dt>
        <dd className="text-right">{payment.subscriberName}</dd>
        <dt className="text-muted">Method</dt>
        <dd className="text-right">{methodLabel(payment.method)}</dd>
        {payment.referenceNumber && (
          <>
            <dt className="text-muted">Reference</dt>
            <dd className="text-right">{payment.referenceNumber}</dd>
          </>
        )}
      </dl>

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-muted">
            <th scope="col" className="py-1 text-left font-medium">
              Applied to
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {payment.allocations.map((a) => (
            <tr key={`${a.invoiceId}-${a.allocatedAt}`} className="border-b border-slate-100">
              <td className="py-1">
                {a.invoiceNumber} · {periodLabel(periodOf(a.periodStart))}
                <span className="block text-xs text-muted">
                  {a.serviceNumber}
                  {a.source === "credit" ? ` · from credit, ${formatDateTime(a.allocatedAt)}` : ""}
                </span>
              </td>
              <td className="money py-1">{formatPesos(a.amountCentavos)}</td>
            </tr>
          ))}
          {payment.creditCentavos > 0 && (
            <tr className="border-b border-slate-100">
              <td className="py-1">
                Credit for future bills
                <span className="block text-xs text-muted">Applied automatically when the next bills are issued</span>
              </td>
              <td className="money py-1">{formatPesos(payment.creditCentavos)}</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="pt-2 text-left font-semibold">
              Total received
            </th>
            <td className="money pt-2 text-base font-semibold">{formatPesos(payment.amountCentavos)}</td>
          </tr>
        </tfoot>
      </table>

      {payment.notes && <p className="mt-3 text-xs text-muted">Notes: {payment.notes}</p>}
      {payment.reversal && (
        <p className="mt-3 text-xs text-danger">
          Reversed {formatDateTime(payment.reversal.reversedAt)} by {payment.reversal.reversedByName}:{" "}
          {payment.reversal.reason}
        </p>
      )}

      <footer className="mt-4 border-t border-slate-200 pt-2 text-xs text-muted">
        Received by {payment.receivedByName}. Please keep this receipt.
      </footer>
    </article>
  );
}
