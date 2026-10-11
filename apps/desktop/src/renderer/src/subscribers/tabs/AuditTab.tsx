import { Fragment, useEffect, useState } from "react";
import { REPORT_PAGE_SIZE_DEFAULT } from "@bcis/shared";
import type { AuditLogPageDto } from "../../../../preload/index";
import { AuditChanges } from "../../admin/AuditLogScreen";
import { Pager } from "../../ui/Pager";
import { formatDateTime, RowError, Section } from "../ProfileParts";

const RECORD_LABELS: Record<string, string> = {
  subscriber: "Account",
  service_account: "Service",
  invoice: "Invoice",
  payment: "Payment",
  gcash_submission: "GCash",
};

const th = "table-head px-3 py-2 text-left font-medium text-muted";
const td = "px-3 py-2 align-top";

interface AuditTabProps {
  subscriberId: string;
  onSessionExpired: () => void;
}

/**
 * Read-only audit trail of this subscriber and the records that belong to it (spec 4.4:
 * actor, action, date/time, reason, old and new values). Nothing here can be changed.
 */
export function AuditTab({ subscriberId, onSessionExpired }: AuditTabProps) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AuditLogPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.subscriberTabs.audit(subscriberId, { page, pageSize: REPORT_PAGE_SIZE_DEFAULT }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setResult(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, page, onSessionExpired]);

  return (
    <Section title="Audit trail">
      {error && <RowError message={`Could not load the audit trail. ${error}`} />}
      {!result && !error && <p className="text-sm text-muted">Loading…</p>}
      {result && (
        <div className={loading ? "opacity-60" : undefined}>
          <div className="overflow-auto rounded-lg border border-slate-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className={th}>When</th>
                  <th scope="col" className={th}>Who</th>
                  <th scope="col" className={th}>Action</th>
                  <th scope="col" className={th}>Record</th>
                  <th scope="col" className={th}>Reason</th>
                  <th scope="col" className={th}><span className="sr-only">Values</span></th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted">Nothing recorded yet.</td>
                  </tr>
                )}
                {result.items.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="border-b border-slate-100">
                      <td className={`${td} whitespace-nowrap`}>{formatDateTime(row.occurredAt)}</td>
                      <td className={td}>{row.actor ? row.actor.fullName : <span className="text-muted">System</span>}</td>
                      <td className={`${td} font-mono text-xs`}>{row.action}</td>
                      <td className={td}>{RECORD_LABELS[row.entityType] ?? row.entityType}</td>
                      <td className={td}>{row.reason ?? <span className="text-muted">—</span>}</td>
                      <td className={`${td} text-right`}>
                        <button
                          className="text-xs text-accent hover:underline"
                          aria-expanded={expanded === row.id}
                          onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                        >
                          {expanded === row.id ? "Hide values" : "Values"}
                        </button>
                      </td>
                    </tr>
                    {expanded === row.id && (
                      <tr className="border-b border-slate-100 bg-slate-50/60">
                        <td colSpan={6} className="px-6 py-2">
                          <AuditChanges row={row} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={result.pageSize} total={result.total} loading={loading} onPage={setPage} />
        </div>
      )}
    </Section>
  );
}
