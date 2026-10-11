import { Fragment, useEffect, useState } from "react";
import { formatPesos } from "@bcis/shared";
import type { SubscriberBatchDto, SubscriberDto } from "../../../../preload/index";
import { BatchStatusBadge } from "../../collection/batchLabels";
import { methodLabel, PaymentStatusBadge } from "../../payments/paymentLabels";
import { Field, RowError, Section } from "../ProfileParts";

interface CollectionTabProps {
  subscriber: SubscriberDto;
  onSessionExpired: () => void;
}

const th = "sticky top-0 border-b border-slate-200 bg-slate-50 px-3 py-2 font-medium text-muted";

/** Who collects from this subscriber, and every route the subscriber was on. */
export function CollectionTab({ subscriber, onSessionExpired }: CollectionTabProps) {
  const [batches, setBatches] = useState<SubscriberBatchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.subscriberTabs.collections(subscriber.id).then((r) => {
      if (cancelled) return;
      if (r.ok) setBatches(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriber.id, onSessionExpired]);

  return (
    <div className="space-y-4">
      <Section title="Field collection">
        <dl className="grid grid-cols-3 gap-3">
          <Field label="Area">{subscriber.areaCode ? `${subscriber.areaCode} – ${subscriber.areaName}` : "Not assigned"}</Field>
          <Field label="Collector">
            {subscriber.collectorCode ? `${subscriber.collectorCode} – ${subscriber.collectorName}` : "Not assigned"}
          </Field>
          <Field label="Change">Overview tab › Collection assignment</Field>
        </dl>
      </Section>

      <Section title="Collection batches">
        {error && <RowError message={`Could not load collection batches. ${error}`} />}
        {batches === null && !error && <p className="text-sm text-muted">Loading…</p>}
        {batches && batches.length === 0 && <p className="text-sm text-muted">This subscriber has not been on a collection route.</p>}
        {batches && batches.length > 0 && (
          <div className="overflow-auto rounded-lg border border-slate-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={`${th} text-left`}>Batch</th>
                  <th scope="col" className={`${th} text-left`}>Collection date</th>
                  <th scope="col" className={`${th} text-left`}>Collector</th>
                  <th scope="col" className={`${th} text-left`}>Status</th>
                  <th scope="col" className={`${th} text-right`}>Current</th>
                  <th scope="col" className={`${th} text-right`}>Arrears</th>
                  <th scope="col" className={`${th} text-right`}>Total due</th>
                  <th scope="col" className={`${th} text-right`}>Collected</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <Fragment key={b.batchId}>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <button
                          className="font-medium text-accent hover:underline"
                          aria-expanded={expanded === b.batchId}
                          onClick={() => setExpanded(expanded === b.batchId ? null : b.batchId)}
                        >
                          {b.batchNumber}
                        </button>
                      </td>
                      <td className="px-3 py-2">{b.collectionDate}</td>
                      <td className="px-3 py-2">{b.collectorName}</td>
                      <td className="px-3 py-2"><BatchStatusBadge status={b.status} /></td>
                      <td className="money px-3 py-2">{formatPesos(b.currentCentavos)}</td>
                      <td className="money px-3 py-2">{formatPesos(b.arrearsCentavos)}</td>
                      <td className="money px-3 py-2">{formatPesos(b.totalDueCentavos)}</td>
                      <td className="money px-3 py-2 font-medium">{formatPesos(b.collectedCentavos)}</td>
                    </tr>
                    {expanded === b.batchId && (
                      <tr className="border-b border-slate-100 bg-slate-50/60">
                        <td colSpan={8} className="px-6 py-2">
                          {b.collections.length === 0 ? (
                            <span className="text-muted">Nothing was collected from this subscriber on this route.</span>
                          ) : (
                            <ul className="space-y-1">
                              {b.collections.map((c) => (
                                <li key={c.paymentId} className="flex items-center gap-3">
                                  <span className="font-medium">{c.receiptNumber}</span>
                                  <span>{c.paymentDate}</span>
                                  <span>{methodLabel(c.method)}</span>
                                  <span className="money">{formatPesos(c.amountCentavos)}</span>
                                  <PaymentStatusBadge status={c.status} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Current, arrears and total due are the route-sheet figures from when the subscriber was put on the batch.
          Collected counts posted collections only; reversed ones are listed under the batch number.
        </p>
      </Section>
    </div>
  );
}
