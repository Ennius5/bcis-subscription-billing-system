import { useEffect, useState } from "react";
import { formatPesos, RECEIVABLE_PAGE_SIZE_DEFAULT, type PermissionCode } from "@bcis/shared";
import type { ReceivablePageDto, ReceivableRowDto } from "../../../preload/index";
import { ServiceAccountScreen } from "../service-accounts/ServiceAccountScreen";
import { StatusBadge } from "../subscribers/status";
import { DataTable, type Column } from "../ui/DataTable";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import {
  BUCKET_OPTIONS,
  BucketBadge,
  CountTile,
  FilterBar,
  MoneyTile,
  NO_FILTERS,
  hasFilters,
  useFilterOptions,
  type ReceivableFilters,
} from "./receivableParts";

const SEARCH_DELAY_MS = 300;

const SORT_OPTIONS: SelectOption[] = [
  { value: "oldest", label: "Oldest unpaid first" },
  { value: "arrears", label: "Largest arrears first" },
  { value: "balance", label: "Largest balance first" },
  { value: "name", label: "Subscriber name" },
];

interface ReceivablesScreenProps {
  view: "outstanding" | "overdue";
  permissions: readonly PermissionCode[];
  /** Opens the subscriber's profile (All Subscribers). */
  onOpenSubscriber: (id: string) => void;
  onSessionExpired: () => void;
}

/**
 * Outstanding (every open balance) and Overdue (accounts with arrears): one row per service
 * account, as of the server's today. A service opens here with Back; a subscriber opens
 * their profile.
 */
export function ReceivablesScreen({ view, permissions, onOpenSubscriber, onSessionExpired }: ReceivablesScreenProps) {
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const title = view === "overdue" ? "Overdue" : "Outstanding";

  return (
    <>
      {/* The list stays mounted while a service is open, so filters and page survive the round trip. */}
      <div hidden={openServiceId !== null}>
        <h1 className="mb-1 text-xl font-semibold text-navy">{title}</h1>
        <p className="mb-4 text-sm text-muted">
          {view === "overdue"
            ? "Service accounts with at least one invoice past its due date."
            : "Every service account with an unpaid balance, including bills not yet due."}
        </p>
        <ReceivableList
          view={view}
          reloadKey={reloadKey}
          canOpenService={permissions.includes("service.view")}
          canOpenSubscriber={permissions.includes("subscriber.view")}
          onOpenService={setOpenServiceId}
          onOpenSubscriber={onOpenSubscriber}
          onSessionExpired={onSessionExpired}
        />
      </div>
      {openServiceId && (
        <ServiceAccountScreen
          key={openServiceId}
          serviceAccountId={openServiceId}
          canManage={permissions.includes("service.manage")}
          canControl={permissions.includes("suspension.manage")}
          backLabel={`Back to ${title.toLowerCase()}`}
          onBack={() => {
            setOpenServiceId(null);
            setReloadKey((k) => k + 1);
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

interface ReceivableListProps {
  view: "outstanding" | "overdue";
  reloadKey: number;
  canOpenService: boolean;
  canOpenSubscriber: boolean;
  onOpenService: (id: string) => void;
  onOpenSubscriber: (id: string) => void;
  onSessionExpired: () => void;
}

function ReceivableList({
  view,
  reloadKey,
  canOpenService,
  canOpenSubscriber,
  onOpenService,
  onOpenSubscriber,
  onSessionExpired,
}: ReceivableListProps) {
  const options = useFilterOptions(onSessionExpired);
  const [filters, setFilters] = useState<ReceivableFilters>(NO_FILTERS);
  const [bucket, setBucket] = useState("");
  const [sort, setSort] = useState("oldest");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ReceivablePageDto | null>(null);
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
    void window.bcis.receivables
      .list({ view, ...filters, bucket, search, sort, page, pageSize: RECEIVABLE_PAGE_SIZE_DEFAULT })
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
  }, [view, filters, bucket, search, sort, page, reloadKey, onSessionExpired]);

  const columns: Column<ReceivableRowDto>[] = [
    {
      key: "subscriber",
      header: "Subscriber",
      render: (r) => (
        <>
          {canOpenSubscriber ? (
            <button className="font-medium text-accent hover:underline" onClick={() => onOpenSubscriber(r.subscriberId)}>
              {r.subscriberName}
            </button>
          ) : (
            <span className="font-medium">{r.subscriberName}</span>
          )}
          <span className="block text-xs text-muted">{r.accountNumber}</span>
        </>
      ),
    },
    {
      key: "service",
      header: "Service",
      render: (r) => (
        <>
          {canOpenService ? (
            <button className="text-accent hover:underline" onClick={() => onOpenService(r.serviceAccountId)}>
              {r.serviceNumber}
            </button>
          ) : (
            r.serviceNumber
          )}
          <span className="block text-xs text-muted">{r.planName}</span>
          {r.serviceStatus !== "active" && (
            <span className="mt-0.5 block">
              <StatusBadge status={r.serviceStatus} />
            </span>
          )}
        </>
      ),
    },
    {
      key: "area",
      header: "Area / collector",
      render: (r) => (
        <>
          {r.areaName ?? <span className="text-muted">No area</span>}
          <span className="block text-xs text-muted">{r.collectorName ?? "No collector"}</span>
        </>
      ),
    },
    { key: "months", header: "Months unpaid", align: "right", render: (r) => r.monthsUnpaid },
    {
      key: "oldest",
      header: "Oldest unpaid",
      render: (r) => (
        <>
          {r.oldestInvoiceNumber}
          <span className="block text-xs text-muted">
            due {r.oldestDueDate}
            {r.daysPastDue > 0 && ` · ${r.daysPastDue} days late`}
          </span>
        </>
      ),
    },
    { key: "age", header: "Age", render: (r) => <BucketBadge bucket={r.bucket} /> },
    { key: "lastPaid", header: "Last payment", render: (r) => r.lastPaymentDate ?? <span className="text-muted">None</span> },
    { key: "arrears", header: "Arrears", align: "right", render: (r) => formatPesos(r.arrearsCentavos) },
    { key: "open", header: "Total open", align: "right", render: (r) => formatPesos(r.totalOpenCentavos) },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? RECEIVABLE_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = hasFilters(filters) || bucket !== "" || search !== "";

  return (
    <div>
      {result && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          <CountTile label="Service accounts" count={result.total} note={`As of ${result.asOf}`} />
          <MoneyTile label="Arrears (past due)" centavos={result.totalArrearsCentavos} />
          <MoneyTile label="Not yet due" centavos={result.totalOpenCentavos - result.totalArrearsCentavos} />
          <MoneyTile label="Total open" centavos={result.totalOpenCentavos} />
        </div>
      )}

      <div className="mb-4 grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <TextField label="Search account no., name or service no." value={searchText} onChange={setSearchText} maxLength={100} />
        </div>
        <SelectField
          label="Delinquency age"
          value={bucket}
          onChange={(v) => {
            setBucket(v);
            setPage(1);
          }}
          options={BUCKET_OPTIONS}
        />
        <SelectField
          label="Sort"
          value={sort}
          onChange={(v) => {
            setSort(v);
            setPage(1);
          }}
          options={SORT_OPTIONS}
        />
        <FilterBar
          value={filters}
          options={options}
          onChange={(next) => {
            setFilters(next);
            setPage(1);
          }}
        />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the list. {loadError}
        </p>
      )}

      {loading && !result ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(r) => r.serviceAccountId}
            emptyMessage={
              filtered
                ? "No service accounts match these filters."
                : view === "overdue"
                  ? "Nothing is overdue."
                  : "No unpaid balances."
            }
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
