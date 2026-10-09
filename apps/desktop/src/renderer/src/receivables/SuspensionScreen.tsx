import { useEffect, useState } from "react";
import { formatPesos, RECEIVABLE_PAGE_SIZE_DEFAULT, type PermissionCode } from "@bcis/shared";
import type {
  ReconnectionDto,
  ReconnectionPageDto,
  SuspensionCandidateDto,
  SuspensionCandidateListDto,
} from "../../../preload/index";
import { feeText, ReconnectionStatusBadge } from "../service-accounts/ServiceControl";
import { ServiceAccountScreen } from "../service-accounts/ServiceAccountScreen";
import { DataTable, type Column } from "../ui/DataTable";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { BucketBadge, FilterBar, NO_FILTERS, hasFilters, useFilterOptions, type ReceivableFilters } from "./receivableParts";

const SEARCH_DELAY_MS = 300;

type Tab = "candidates" | "reconnections";

interface SuspensionScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/**
 * Receivables > Suspension Candidates (suspension.manage). Two tabs: the candidate list
 * (advice only: suspending is done on the service, with a reason and approval) and the
 * reconnection work list. A service opens here with Back to the tab it came from.
 */
export function SuspensionScreen({ permissions, onSessionExpired }: SuspensionScreenProps) {
  const [tab, setTab] = useState<Tab>("candidates");
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const tabs: { id: Tab; label: string }[] = [
    { id: "candidates", label: "Candidates" },
    { id: "reconnections", label: "Reconnections" },
  ];

  return (
    <>
      {/* Both tabs stay mounted while a service is open, so filters survive the round trip. */}
      <div hidden={openServiceId !== null}>
        <div role="tablist" aria-label="Suspension view" className="mb-4 flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`rounded px-3 py-1 text-sm ${
                tab === t.id ? "bg-navy text-white" : "border border-slate-300 text-ink hover:bg-slate-50"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div hidden={tab !== "candidates"}>
          <CandidateList reloadKey={reloadKey} onOpen={setOpenServiceId} onSessionExpired={onSessionExpired} />
        </div>
        <div hidden={tab !== "reconnections"}>
          <ReconnectionList reloadKey={reloadKey} onOpen={setOpenServiceId} onSessionExpired={onSessionExpired} />
        </div>
      </div>
      {openServiceId && (
        <ServiceAccountScreen
          key={openServiceId}
          serviceAccountId={openServiceId}
          canManage={permissions.includes("service.manage")}
          canControl={permissions.includes("suspension.manage")}
          backLabel={tab === "candidates" ? "Back to suspension candidates" : "Back to reconnections"}
          onBack={() => {
            setOpenServiceId(null);
            setReloadKey((k) => k + 1); // a suspension or reconnection changes both lists
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

/* ------------------------------ Candidates ------------------------------ */

interface ListProps {
  reloadKey: number;
  onOpen: (serviceAccountId: string) => void;
  onSessionExpired: () => void;
}

function CandidateList({ reloadKey, onOpen, onSessionExpired }: ListProps) {
  const options = useFilterOptions(onSessionExpired);
  const [filters, setFilters] = useState<ReceivableFilters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<SuspensionCandidateListDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.serviceControl.candidates({ ...filters, search }).then((r) => {
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
  }, [filters, search, reloadKey, onSessionExpired]);

  const columns: Column<SuspensionCandidateDto>[] = [
    {
      key: "service",
      header: "Service",
      render: (c) => (
        <>
          <button className="font-medium text-accent hover:underline" onClick={() => onOpen(c.serviceAccountId)}>
            {c.serviceNumber}
          </button>
          <span className="block text-xs text-muted">{c.planName}</span>
        </>
      ),
    },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (c) => (
        <>
          {c.subscriberName}
          <span className="block text-xs text-muted">{c.accountNumber}</span>
        </>
      ),
    },
    {
      key: "area",
      header: "Area / collector",
      render: (c) => (
        <>
          {c.areaName ?? <span className="text-muted">No area</span>}
          <span className="block text-xs text-muted">{c.collectorName ?? "No collector"}</span>
        </>
      ),
    },
    { key: "count", header: "Bills past grace", align: "right", render: (c) => c.pastGraceCount },
    {
      key: "oldest",
      header: "Oldest unpaid",
      render: (c) => (
        <>
          {c.oldestInvoiceNumber}
          <span className="block text-xs text-muted">
            due {c.oldestDueDate} · {c.daysPastDue} days late
          </span>
        </>
      ),
    },
    { key: "age", header: "Age", render: (c) => <BucketBadge bucket={c.bucket} /> },
    { key: "lastPaid", header: "Last payment", render: (c) => c.lastPaymentDate ?? <span className="text-muted">None</span> },
    { key: "pastGrace", header: "Past grace", align: "right", render: (c) => formatPesos(c.pastGraceCentavos) },
    { key: "open", header: "Total open", align: "right", render: (c) => formatPesos(c.totalOpenCentavos) },
  ];

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-navy">Suspension Candidates</h1>
      {result && (
        <p className="mb-4 text-sm text-muted">
          Active services with at least {result.settings.suspensionThresholdInvoices} unpaid bill
          {result.settings.suspensionThresholdInvoices === 1 ? "" : "s"} more than {result.settings.gracePeriodDays} day
          {result.settings.gracePeriodDays === 1 ? "" : "s"} past due, as of {result.asOf}. This list is advice: open a
          service to suspend it with a reason and approval.
        </p>
      )}

      <div className="mb-4 grid grid-cols-4 gap-3">
        <div className="col-span-4">
          <TextField label="Search account no., name or service no." value={searchText} onChange={setSearchText} maxLength={100} />
        </div>
        <FilterBar value={filters} options={options} onChange={setFilters} />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the candidates. {loadError}
        </p>
      )}

      {!result && !loadError ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(c) => c.serviceAccountId}
            emptyMessage={
              hasFilters(filters) || search !== ""
                ? "No candidates match these filters."
                : "No service is past the grace period. Nothing to suspend."
            }
          />
          {result && result.items.length > 0 && (
            <p className="mt-3 text-sm text-muted" aria-live="polite">
              {result.items.length} candidate{result.items.length === 1 ? "" : "s"}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ----------------------------- Reconnections ----------------------------- */

const RECONNECTION_STATUS_OPTIONS: SelectOption[] = [
  { value: "open", label: "Open (requested or assigned)" },
  { value: "requested", label: "Requested" },
  { value: "assigned", label: "Assigned" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "", label: "All" },
];

function ReconnectionList({ reloadKey, onOpen, onSessionExpired }: ListProps) {
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ReconnectionPageDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.serviceControl
      .listReconnections({ status, page, pageSize: RECEIVABLE_PAGE_SIZE_DEFAULT })
      .then((r) => {
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

  const columns: Column<ReconnectionDto>[] = [
    {
      key: "service",
      header: "Service",
      render: (r) => (
        <button className="font-medium text-accent hover:underline" onClick={() => onOpen(r.serviceAccountId)}>
          {r.serviceNumber}
        </button>
      ),
    },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (r) => (
        <>
          {r.subscriberName}
          <span className="block text-xs text-muted">{r.accountNumber}</span>
        </>
      ),
    },
    {
      key: "requested",
      header: "Requested",
      render: (r) => (
        <>
          {r.requestDate}
          <span className="block text-xs text-muted">by {r.requestedByName}</span>
        </>
      ),
    },
    { key: "technician", header: "Technician", render: (r) => r.technicianName ?? <span className="text-muted">Not assigned</span> },
    { key: "status", header: "Status", render: (r) => <ReconnectionStatusBadge status={r.status} /> },
    {
      key: "outcome",
      header: "Outcome",
      render: (r) =>
        r.status === "completed" ? (
          `Reconnected ${r.completionDate}`
        ) : r.status === "cancelled" ? (
          <span className="text-muted">{r.cancelReason}</span>
        ) : (
          <span className="text-muted">In progress</span>
        ),
    },
    { key: "fee", header: "Fee", align: "right", render: (r) => feeText(r) },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? RECEIVABLE_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-navy">Reconnections</h1>
      <p className="mb-4 text-sm text-muted">
        Requests to restore suspended services. Open a service to assign a technician, complete or cancel.
      </p>
      <div className="mb-4 grid grid-cols-4 gap-3">
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={RECONNECTION_STATUS_OPTIONS}
        />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load reconnections. {loadError}
        </p>
      )}

      {!result && !loadError ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(r) => r.id}
            emptyMessage={status === "open" ? "No reconnection is waiting." : "No reconnections."}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-muted">
            <span aria-live="polite">{total === 0 ? "No results" : `${total} reconnection${total === 1 ? "" : "s"}`}</span>
            <span className="flex items-center gap-2">
              <button
                className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 disabled:opacity-50"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {lastPage}
              </span>
              <button
                className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 disabled:opacity-50"
                disabled={page >= lastPage}
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
