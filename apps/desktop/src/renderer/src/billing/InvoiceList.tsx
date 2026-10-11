import { useEffect, useState } from "react";
import { formatPesos, INVOICE_DISPLAY_STATUSES, INVOICE_PAGE_SIZE_DEFAULT, periodLabel, periodOf } from "@bcis/shared";
import type { InvoiceDto, InvoicePageDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { MonthField } from "../ui/MonthField";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { InvoiceStatusBadge, invoiceStatusLabel } from "./invoiceStatus";

const SEARCH_DELAY_MS = 300;

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All statuses" },
  ...INVOICE_DISPLAY_STATUSES.map((s) => ({ value: s, label: invoiceStatusLabel(s) })),
];

interface InvoiceListProps {
  /** Starting month filter ("" for all months). Ignored when `fixed` is given. */
  initialPeriod?: string;
  /** Locks the list to one month and status and hides the filters (e.g. a month's drafts). */
  fixed?: { period: string; status: string };
  /** Bumped by the parent to refetch, e.g. after generating or returning from an invoice. */
  reloadKey: number;
  /** Only this subscriber's invoices (the profile's Billing tab); the Subscriber column is dropped. */
  subscriberId?: string;
  emptyMessage?: string;
  onOpen?: (id: string) => void;
  onSessionExpired: () => void;
}

export function InvoiceList({
  initialPeriod = "",
  fixed,
  reloadKey,
  subscriberId,
  emptyMessage,
  onOpen,
  onSessionExpired,
}: InvoiceListProps) {
  const [period, setPeriod] = useState(initialPeriod);
  const [status, setStatus] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<InvoicePageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const queryPeriod = fixed ? fixed.period : period;
  const queryStatus = fixed ? fixed.status : status;
  const isFixed = fixed !== undefined;

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
    void window.bcis.billing
      .listInvoices({
        page,
        pageSize: INVOICE_PAGE_SIZE_DEFAULT,
        period: queryPeriod,
        status: queryStatus,
        search: isFixed ? "" : search,
        ...(subscriberId ? { subscriberId } : {}),
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
  }, [page, queryPeriod, queryStatus, search, isFixed, subscriberId, reloadKey, onSessionExpired]);

  const changeFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const allColumns: Column<InvoiceDto>[] = [
    {
      key: "number",
      header: "Invoice no.",
      render: (i) => {
        const label = i.invoiceNumber ?? "Draft";
        return onOpen ? (
          <button className="font-medium text-accent hover:underline" onClick={() => onOpen(i.id)}>
            {label}
          </button>
        ) : (
          <span className="font-medium">{label}</span>
        );
      },
    },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (i) => (
        <>
          {i.subscriberName}
          <span className="block text-xs text-muted">{i.accountNumber}</span>
        </>
      ),
    },
    { key: "service", header: "Service no.", render: (i) => i.serviceNumber },
    { key: "month", header: "Month", render: (i) => periodLabel(periodOf(i.periodStart)) },
    { key: "due", header: "Due", render: (i) => i.dueDate },
    { key: "status", header: "Status", render: (i) => <InvoiceStatusBadge status={i.displayStatus} /> },
    { key: "total", header: "Total", align: "right", render: (i) => formatPesos(i.totalCentavos) },
    { key: "balance", header: "Balance", align: "right", render: (i) => formatPesos(i.balanceCentavos) },
  ];
  const columns = subscriberId ? allColumns.filter((c) => c.key !== "subscriber") : allColumns;

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? INVOICE_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = !fixed && (period !== "" || status !== "" || search !== "");

  return (
    <div>
      {!fixed && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <TextField
              label="Search invoice no., account no., service no. or name"
              value={searchText}
              onChange={setSearchText}
              maxLength={100}
            />
          </div>
          <MonthField label="Month" value={period} onChange={changeFilter(setPeriod)} hint="Clear for all months." />
          <SelectField label="Status" value={status} onChange={changeFilter(setStatus)} options={STATUS_OPTIONS} />
        </div>
      )}

      {loadError && (
        <p role="alert" className="alert alert-danger mb-4">
          Could not load invoices. {loadError}
        </p>
      )}

      {loading && !result ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(i) => i.id}
            emptyMessage={emptyMessage ?? (filtered ? "No invoices match these filters." : "No invoices yet.")}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-muted">
            <span aria-live="polite">{total === 0 ? "No results" : `Showing ${first}–${last} of ${total}`}</span>
            <span className="flex items-center gap-2">
              <button
                className="btn btn-secondary btn-sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {lastPage}
              </span>
              <button
                className="btn btn-secondary btn-sm"
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
