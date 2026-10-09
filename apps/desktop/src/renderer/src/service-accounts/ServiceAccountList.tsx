import { useEffect, useState } from "react";
import {
  formatPesos,
  SERVICE_ACCOUNT_PAGE_SIZE_DEFAULT,
  SERVICE_ACCOUNT_STATUSES,
  SERVICE_TYPE_CODES,
} from "@bcis/shared";
import type { ServiceAccountDto, ServiceAccountPageDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { serviceTypeLabel, statusLabel, StatusBadge } from "../subscribers/status";

const SEARCH_DELAY_MS = 300;

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All statuses" },
  ...SERVICE_ACCOUNT_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
];

const TYPE_OPTIONS: SelectOption[] = [
  { value: "", label: "All types" },
  ...SERVICE_TYPE_CODES.map((t) => ({ value: t, label: serviceTypeLabel(t) })),
];

interface ServiceAccountListProps {
  /** Bumped by the parent to refetch the current page, e.g. after returning from an account. */
  reloadKey: number;
  onOpen: (id: string) => void;
  onSessionExpired: () => void;
}

export function ServiceAccountList({ reloadKey, onOpen, onSessionExpired }: ServiceAccountListProps) {
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<ServiceAccountPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Wait for a pause in typing before searching, and start again from page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.serviceAccounts
      .list({ page, pageSize: SERVICE_ACCOUNT_PAGE_SIZE_DEFAULT, status, serviceType, search })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setResult(r.data);
          setLoadError(null);
        } else if (r.code === "UNAUTHENTICATED") {
          onSessionExpired();
          return;
        } else {
          setLoadError(r.message);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, status, serviceType, search, reloadKey, onSessionExpired]);

  const changeFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const columns: Column<ServiceAccountDto>[] = [
    {
      key: "number",
      header: "Service no.",
      render: (s) => (
        <button
          className="font-medium text-accent hover:underline"
          onClick={() => onOpen(s.id)}
          title={`Open ${s.serviceNumber}`}
        >
          {s.serviceNumber}
        </button>
      ),
    },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (s) => (
        <>
          {s.subscriberName}
          <span className="block text-xs text-muted">{s.accountNumber}</span>
        </>
      ),
    },
    { key: "type", header: "Type", render: (s) => serviceTypeLabel(s.serviceType) },
    { key: "plan", header: "Plan", render: (s) => `${s.planCode} – ${s.planName}` },
    { key: "status", header: "Status", render: (s) => <StatusBadge status={s.status} /> },
    { key: "collector", header: "Collector", render: (s) => s.collectorName ?? "—" },
    { key: "activated", header: "Activated", render: (s) => s.activationDate ?? "—" },
    { key: "rate", header: "Monthly rate", align: "right", render: (s) => formatPesos(s.currentRateCentavos) },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? SERVICE_ACCOUNT_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = search !== "" || status !== "" || serviceType !== "";

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">Service Accounts</h1>

      <div className="mb-4 grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <TextField
            label="Search service no., account no. or name"
            value={searchText}
            onChange={setSearchText}
            maxLength={100}
          />
        </div>
        <SelectField label="Status" value={status} onChange={changeFilter(setStatus)} options={STATUS_OPTIONS} />
        <SelectField label="Type" value={serviceType} onChange={changeFilter(setServiceType)} options={TYPE_OPTIONS} />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load service accounts. {loadError}
        </p>
      )}

      {loading && !result ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(s) => s.id}
            emptyMessage={filtered ? "No service accounts match these filters." : "No service accounts yet."}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-muted">
            <span aria-live="polite">
              {total === 0 ? "No results" : `Showing ${first}–${last} of ${total}`}
            </span>
            <span className="flex items-center gap-2">
              <button
                className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 disabled:opacity-50"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {lastPage}
              </span>
              <button
                className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 disabled:opacity-50"
                disabled={page >= lastPage || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
