import { useEffect, useState } from "react";
import { SUBSCRIBER_PAGE_SIZE_DEFAULT, SUBSCRIBER_STATUSES } from "@bcis/shared";
import type { SubscriberListItemDto, SubscriberPageDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { statusLabel, StatusBadge } from "./status";

const SEARCH_DELAY_MS = 300;

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All except archived" },
  ...SUBSCRIBER_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
];

interface SubscriberListProps {
  /** Bumped by the parent to refetch the current page, e.g. after returning from a profile. */
  reloadKey: number;
  onOpen: (id: string) => void;
  onSessionExpired: () => void;
}

export function SubscriberList({ reloadKey, onOpen, onSessionExpired }: SubscriberListProps) {
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [areaId, setAreaId] = useState("");
  const [collectorId, setCollectorId] = useState("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<SubscriberPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Area and collector filters need collection.view. Without it the filter is simply hidden.
  const [areaOptions, setAreaOptions] = useState<SelectOption[] | null>(null);
  const [collectorOptions, setCollectorOptions] = useState<SelectOption[] | null>(null);

  useEffect(() => {
    // Inactive areas and collectors are included: subscribers may still be assigned to them.
    void window.bcis.collectionAreas.list(true).then((r) => {
      if (r.ok) {
        setAreaOptions([
          { value: "", label: "All areas" },
          ...r.data.map((a) => ({ value: a.id, label: `${a.code} – ${a.name}` })),
        ]);
      }
    });
    void window.bcis.collectors.list(true).then((r) => {
      if (r.ok) {
        setCollectorOptions([
          { value: "", label: "All collectors" },
          ...r.data.map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}` })),
        ]);
      }
    });
  }, []);

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
    void window.bcis.subscribers
      .list({
        page,
        pageSize: SUBSCRIBER_PAGE_SIZE_DEFAULT,
        status,
        collectionAreaId: areaId,
        assignedCollectorId: collectorId,
        search,
      })
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
  }, [page, status, areaId, collectorId, search, reloadKey, onSessionExpired]);

  const changeFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const columns: Column<SubscriberListItemDto>[] = [
    {
      key: "account",
      header: "Account no.",
      render: (s) => (
        <button
          className="font-medium text-accent hover:underline"
          onClick={() => onOpen(s.id)}
          title={`Open ${s.fullName}`}
        >
          {s.accountNumber}
        </button>
      ),
    },
    { key: "name", header: "Name", render: (s) => s.fullName },
    { key: "status", header: "Status", render: (s) => <StatusBadge status={s.status} /> },
    { key: "area", header: "Area", render: (s) => s.areaCode ?? "—" },
    { key: "collector", header: "Collector", render: (s) => s.collectorName ?? "—" },
    { key: "contact", header: "Primary contact", render: (s) => s.primaryContact ?? "—" },
    { key: "address", header: "Address", render: (s) => s.primaryAddress ?? "—" },
    { key: "billingDay", header: "Billing day", align: "right", render: (s) => s.billingDay },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? SUBSCRIBER_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = search !== "" || status !== "" || areaId !== "" || collectorId !== "";

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-navy">All Subscribers</h1>

      <div className="mb-4 grid grid-cols-4 gap-3">
        <TextField
          label="Search name or account no."
          value={searchText}
          onChange={setSearchText}
          maxLength={100}
        />
        <SelectField label="Status" value={status} onChange={changeFilter(setStatus)} options={STATUS_OPTIONS} />
        {areaOptions && (
          <SelectField label="Area" value={areaId} onChange={changeFilter(setAreaId)} options={areaOptions} />
        )}
        {collectorOptions && (
          <SelectField
            label="Collector"
            value={collectorId}
            onChange={changeFilter(setCollectorId)}
            options={collectorOptions}
          />
        )}
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load subscribers. {loadError}
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
            emptyMessage={filtered ? "No subscribers match these filters." : "No subscribers yet."}
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
