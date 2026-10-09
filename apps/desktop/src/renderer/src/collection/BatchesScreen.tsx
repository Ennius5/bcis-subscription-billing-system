import { useEffect, useState } from "react";
import { BATCH_PAGE_SIZE_DEFAULT, formatPesos, type PermissionCode } from "@bcis/shared";
import type { BatchListItemDto, BatchPageDto, CollectorDto, CreateBatchResultDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { BATCH_STATUS_OPTIONS, BatchStatusBadge } from "./batchLabels";
import { BatchView } from "./BatchView";
import { NewBatchForm } from "./NewBatchForm";

interface BatchesScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Collection Batches: the list, building a new batch, and one batch's detail. */
export function BatchesScreen({ permissions, onSessionExpired }: BatchesScreenProps) {
  const canManage = permissions.includes("collection.manage");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [skipped, setSkipped] = useState<CreateBatchResultDto["skipped"]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  function backToList() {
    setOpenId(null);
    setSkipped([]);
    setReloadKey((k) => k + 1); // a status or account change shows in the list
  }

  return (
    <>
      {/* The list stays mounted while a batch is open, so filters and page survive the round trip. */}
      <div hidden={openId !== null}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-navy">Collection Batches</h1>
          {canManage && !creating && (
            <button
              className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90"
              onClick={() => setCreating(true)}
            >
              New batch
            </button>
          )}
        </div>
        {creating && (
          <NewBatchForm
            onCreated={(result) => {
              setCreating(false);
              setSkipped(result.skipped);
              setOpenId(result.batch.id);
            }}
            onCancel={() => setCreating(false)}
            onSessionExpired={onSessionExpired}
          />
        )}
        <BatchList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
      </div>
      {openId && (
        <BatchView
          key={openId}
          batchId={openId}
          skipped={skipped}
          permissions={permissions}
          onBack={backToList}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

interface BatchListProps {
  /** Shows only this status and hides the status filter (the Remittance work queues). */
  fixedStatus?: string;
  /** Shown when there is nothing to list and no filter is set. */
  emptyMessage?: string;
  reloadKey: number;
  onOpen: (id: string) => void;
  onSessionExpired: () => void;
}

export function BatchList({ fixedStatus, emptyMessage, reloadKey, onOpen, onSessionExpired }: BatchListProps) {
  const [chosenStatus, setStatus] = useState("");
  const status = fixedStatus ?? chosenStatus;
  const [collectorId, setCollectorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [collectors, setCollectors] = useState<CollectorDto[]>([]);
  const [result, setResult] = useState<BatchPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Inactive collectors too: their old batches must stay findable.
  useEffect(() => {
    void window.bcis.collectors.list(true).then((r) => {
      if (r.ok) setCollectors(r.data);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.batches
      .list({ page, pageSize: BATCH_PAGE_SIZE_DEFAULT, status, collectorId, from, to })
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
  }, [page, status, collectorId, from, to, reloadKey, onSessionExpired]);

  const changeFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const collectorOptions: SelectOption[] = [
    { value: "", label: "All collectors" },
    ...collectors.map((c) => ({ value: c.id, label: `${c.code} · ${c.fullName}${c.isActive ? "" : " (inactive)"}` })),
  ];

  const columns: Column<BatchListItemDto>[] = [
    {
      key: "number",
      header: "Batch no.",
      render: (b) => (
        <button className="font-medium text-accent hover:underline" onClick={() => onOpen(b.id)}>
          {b.batchNumber}
        </button>
      ),
    },
    { key: "date", header: "Collection date", render: (b) => b.collectionDate },
    {
      key: "collector",
      header: "Collector",
      render: (b) => (
        <>
          {b.collectorName}
          <span className="block text-xs text-muted">{b.collectorCode}</span>
        </>
      ),
    },
    { key: "area", header: "Area", render: (b) => b.areaCode ?? "All areas" },
    { key: "status", header: "Status", render: (b) => <BatchStatusBadge status={b.status} /> },
    { key: "accounts", header: "Accounts", align: "right", render: (b) => b.accountCount },
    { key: "due", header: "Total due", align: "right", render: (b) => formatPesos(b.totalDueCentavos) },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? BATCH_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = chosenStatus !== "" || collectorId !== "" || from !== "" || to !== "";

  return (
    <div>
      <div className="mb-4 grid grid-cols-4 gap-3">
        {fixedStatus === undefined && (
          <SelectField label="Status" value={status} onChange={changeFilter(setStatus)} options={BATCH_STATUS_OPTIONS} />
        )}
        <SelectField
          label="Collector"
          value={collectorId}
          onChange={changeFilter(setCollectorId)}
          options={collectorOptions}
        />
        <DateField label="Collection date from" value={from} onChange={changeFilter(setFrom)} />
        <DateField label="Collection date to" value={to} onChange={changeFilter(setTo)} />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load batches. {loadError}
        </p>
      )}

      {loading && !result ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(b) => b.id}
            emptyMessage={filtered ? "No batches match these filters." : (emptyMessage ?? "No collection batches yet.")}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-muted">
            <span aria-live="polite">{total === 0 ? "No results" : `Showing ${first}–${last} of ${total}`}</span>
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
