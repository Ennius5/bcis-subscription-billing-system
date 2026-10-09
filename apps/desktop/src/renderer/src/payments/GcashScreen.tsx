import { useEffect, useState } from "react";
import { formatPesos, GCASH_PAGE_SIZE_DEFAULT, type PermissionCode } from "@bcis/shared";
import type { GcashSubmissionPageDto } from "../../../preload/index";
import { RowError } from "../subscribers/ProfileParts";
import { GcashDetail, GcashStatusBadge } from "./GcashDetail";
import { RecordGcashForm } from "./RecordGcashForm";

const TABS = [
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "reversed", label: "Reversed" },
  { value: "", label: "All" },
] as const;

interface GcashScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** GCash Verification (spec 3.7, 4.1): the queue on the left, the selected submission and its proof on the right. */
export function GcashScreen({ permissions, onSessionExpired }: GcashScreenProps) {
  const canRecord = permissions.includes("payment.create");
  const canVerify = permissions.includes("gcash.verify");
  const [status, setStatus] = useState<string>("pending");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<GcashSubmissionPageDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.gcash.list({ page, pageSize: GCASH_PAGE_SIZE_DEFAULT, status }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setResult(r.data);
        setLoadError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [status, page, reloadKey, onSessionExpired]);

  const total = result?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / (result?.pageSize ?? GCASH_PAGE_SIZE_DEFAULT)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-navy">GCash Verification</h1>
        {canRecord && !recording && (
          <button
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90"
            onClick={() => {
              setRecording(true);
              setSelectedId(null);
            }}
          >
            Record GCash payment
          </button>
        )}
      </div>

      <div className="flex items-start gap-6">
        <aside className="w-96 shrink-0 space-y-3">
          <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                role="tab"
                aria-selected={status === tab.value}
                className={`rounded px-3 py-1 text-sm ${
                  status === tab.value ? "bg-navy text-white" : "border border-slate-300 text-ink hover:bg-slate-50"
                }`}
                onClick={() => {
                  setStatus(tab.value);
                  setPage(1);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {loadError && <RowError message={`Could not load the queue. ${loadError}`} />}
          {!result && !loadError && <p className="text-muted">Loading…</p>}
          {result && result.items.length === 0 && (
            <p className="rounded-lg border border-slate-200 bg-surface px-3 py-6 text-center text-sm text-muted">
              {status === "pending" ? "Nothing waiting for verification." : "No submissions here."}
            </p>
          )}
          {result && result.items.length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-surface">
              {result.items.map((item) => (
                <li key={item.id}>
                  <button
                    aria-current={item.id === selectedId ? "true" : undefined}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${item.id === selectedId ? "bg-accent/5" : ""}`}
                    onClick={() => {
                      setSelectedId(item.id);
                      setRecording(false);
                    }}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{item.referenceNumber}</span>
                      <span className="money font-semibold">{formatPesos(item.amountCentavos)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span>
                        {item.subscriberName} · {item.accountNumber}
                      </span>
                      <GcashStatusBadge status={item.status} />
                    </span>
                    <span className="block text-xs text-muted">
                      Paid {item.transactionDate} · {item.proofCount === 0 ? "no image yet" : `${item.proofCount} image${item.proofCount === 1 ? "" : "s"}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {total > 0 && (
            <div className="flex items-center justify-between text-sm text-muted">
              <span>{total} total</span>
              <span className="flex items-center gap-2">
                <button
                  className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100 disabled:opacity-50"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                {page} / {lastPage}
                <button
                  className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100 disabled:opacity-50"
                  disabled={page >= lastPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </span>
            </div>
          )}
        </aside>

        <section className="min-w-0 flex-1">
          {recording ? (
            <RecordGcashForm
              onCreated={(created) => {
                setRecording(false);
                setStatus("pending");
                setPage(1);
                setSelectedId(created.id);
                setReloadKey((k) => k + 1);
              }}
              onCancel={() => setRecording(false)}
              onSessionExpired={onSessionExpired}
            />
          ) : selectedId ? (
            <GcashDetail
              key={selectedId}
              submissionId={selectedId}
              canAttach={canRecord}
              canVerify={canVerify}
              onChanged={() => setReloadKey((k) => k + 1)}
              onSessionExpired={onSessionExpired}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-12 text-center text-sm text-muted">
              Select a submission to review its proof, or record a new one.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
