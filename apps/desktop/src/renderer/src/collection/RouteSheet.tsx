import { createPortal } from "react-dom";
import { formatPesos } from "@bcis/shared";
import type { BatchDetailDto } from "../../../preload/index";
import { formatDateTime } from "../subscribers/ProfileParts";
import { addressText } from "./batchLabels";

/**
 * The printable route sheet (spec 3.8): account, address, current bill, arrears and total due
 * for each stop, in route order, with blank columns the collector fills in by hand.
 *
 * Rendered outside the app (a portal into <body>) and hidden on screen. When printing,
 * styles.css hides the app and shows only this, laid out normally so a long sheet runs over
 * several landscape pages with the column headings repeated on each.
 */
export function RouteSheet({ batch }: { batch: BatchDetailDto }) {
  const cell = "border border-slate-400 px-1.5 py-1 align-top";
  const money = `${cell} text-right tabular-nums`;

  return createPortal(
    <div className="print-sheet text-[10pt] text-black">
      <header className="mb-3 flex items-start justify-between gap-6">
        <div>
          <div className="text-[12pt] font-semibold">Bukidnon Cable and Internet Services</div>
          <div className="text-[11pt] font-semibold uppercase tracking-wide">Collection Route Sheet</div>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-[9pt]">
          <dt>Batch no.</dt>
          <dd className="font-semibold">{batch.batchNumber}</dd>
          <dt>Collector</dt>
          <dd>
            {batch.collector.code} · {batch.collector.fullName}
          </dd>
          <dt>Area</dt>
          <dd>{batch.area ? `${batch.area.code} · ${batch.area.name}` : "All of the collector's areas"}</dd>
          <dt>Collection date</dt>
          <dd>{batch.collectionDate}</dd>
          <dt>Printed</dt>
          <dd>{formatDateTime(new Date().toISOString())}</dd>
        </dl>
      </header>

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className={cell}>#</th>
            <th className={`${cell} text-left`}>Account / Name</th>
            <th className={`${cell} text-left`}>Address</th>
            <th className={`${cell} text-right`}>Current bill</th>
            <th className={`${cell} text-right`}>Arrears</th>
            <th className={`${cell} text-right`}>Total due</th>
            <th className={`${cell} w-[22mm]`}>Amount collected</th>
            <th className={`${cell} w-[18mm]`}>Receipt no.</th>
            <th className={`${cell} w-[28mm]`}>Signature</th>
          </tr>
        </thead>
        <tbody>
          {batch.accounts.map((a, i) => (
            <tr key={a.subscriberId} className="break-inside-avoid">
              <td className={`${cell} text-right tabular-nums`}>{i + 1}</td>
              <td className={cell}>
                <span className="font-medium">{a.accountNumber}</span>
                <span className="block">{a.fullName}</span>
              </td>
              <td className={cell}>
                {addressText(a) || "No address on file"}
                {a.landmark && <span className="block text-[8pt]">Near {a.landmark}</span>}
                {a.areaCode && <span className="block text-[8pt]">{a.areaCode}</span>}
              </td>
              <td className={money}>{formatPesos(a.currentCentavos)}</td>
              <td className={money}>{formatPesos(a.arrearsCentavos)}</td>
              <td className={`${money} font-semibold`}>
                {formatPesos(a.totalDueCentavos)}
                {a.creditCentavos > 0 && (
                  <span className="block text-[8pt] font-normal">less credit {formatPesos(a.creditCentavos)}</span>
                )}
              </td>
              <td className={cell} />
              <td className={cell} />
              <td className={cell} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={cell} colSpan={3}>
              {batch.totals.accountCount} account{batch.totals.accountCount === 1 ? "" : "s"}
            </td>
            <td className={money}>{formatPesos(batch.totals.currentCentavos)}</td>
            <td className={money}>{formatPesos(batch.totals.arrearsCentavos)}</td>
            <td className={money}>{formatPesos(batch.totals.totalDueCentavos)}</td>
            <td className={cell} />
            <td className={cell} colSpan={2} />
          </tr>
        </tfoot>
      </table>

      <footer className="mt-8 grid grid-cols-3 gap-10 text-[9pt]">
        {["Released by", "Collector", "Received back by"].map((label) => (
          <div key={label}>
            <div className="h-8 border-b border-black" />
            <div className="mt-1">{label} (signature over printed name, date)</div>
          </div>
        ))}
      </footer>
    </div>,
    document.body,
  );
}
