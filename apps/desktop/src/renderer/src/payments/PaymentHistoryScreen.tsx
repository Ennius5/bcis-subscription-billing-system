import { useEffect, useState } from "react";
import { formatPesos, PAYMENT_METHODS, PAYMENT_PAGE_SIZE_DEFAULT, type PermissionCode } from "@bcis/shared";
import type { PaymentListItemDto, PaymentPageDto } from "../../../preload/index";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { methodLabel, PaymentStatusBadge } from "./paymentLabels";
import { PaymentView } from "./PaymentView";

const SEARCH_DELAY_MS = 300;

const METHOD_OPTIONS: SelectOption[] = [
  { value: "", label: "All methods" },
  ...PAYMENT_METHODS.map((m) => ({ value: m, label: methodLabel(m) })),
];

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All" },
  { value: "posted", label: "Posted" },
  { value: "reversed", label: "Reversed" },
];

interface PaymentHistoryScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

export function PaymentHistoryScreen({ permissions, onSessionExpired }: PaymentHistoryScreenProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <>
      {/* The list stays mounted while a payment is open, so filters and page survive the round trip. */}
      <div hidden={openId !== null}>
        <h1 className="mb-4 text-xl font-semibold text-navy">Payment History</h1>
        <PaymentList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
      </div>
      {openId && (
        <PaymentView
          key={openId}
          paymentId={openId}
          canReverse={permissions.includes("payment.reverse")}
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // a reversal changes what the list shows
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

interface PaymentListProps {
  reloadKey: number;
  onOpen: (id: string) => void;
  onSessionExpired: () => void;
}

function PaymentList({ reloadKey, onOpen, onSessionExpired }: PaymentListProps) {
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaymentPageDto | null>(null);
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
    void window.bcis.payments
      .list({ page, pageSize: PAYMENT_PAGE_SIZE_DEFAULT, search, method, status, from, to })
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
  }, [page, search, method, status, from, to, reloadKey, onSessionExpired]);

  const changeFilter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const columns: Column<PaymentListItemDto>[] = [
    {
      key: "receipt",
      header: "Receipt no.",
      render: (p) => (
        <button className="font-medium text-accent hover:underline" onClick={() => onOpen(p.id)}>
          {p.receiptNumber}
        </button>
      ),
    },
    { key: "date", header: "Paid on", render: (p) => p.paymentDate },
    {
      key: "subscriber",
      header: "Subscriber",
      render: (p) => (
        <>
          {p.subscriberName}
          <span className="block text-xs text-muted">{p.accountNumber}</span>
        </>
      ),
    },
    {
      key: "method",
      header: "Method",
      render: (p) => (
        <>
          {methodLabel(p.method)}
          {p.referenceNumber && <span className="block text-xs text-muted">{p.referenceNumber}</span>}
        </>
      ),
    },
    { key: "by", header: "Received by", render: (p) => p.receivedByName },
    { key: "status", header: "Status", render: (p) => <PaymentStatusBadge status={p.status} /> },
    { key: "amount", header: "Amount", align: "right", render: (p) => formatPesos(p.amountCentavos) },
  ];

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? PAYMENT_PAGE_SIZE_DEFAULT;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const filtered = search !== "" || method !== "" || status !== "" || from !== "" || to !== "";

  return (
    <div>
      <div className="mb-4 grid grid-cols-6 gap-3">
        <div className="col-span-2">
          <TextField
            label="Search receipt, reference, account no. or name"
            value={searchText}
            onChange={setSearchText}
            maxLength={100}
          />
        </div>
        <SelectField label="Method" value={method} onChange={changeFilter(setMethod)} options={METHOD_OPTIONS} />
        <SelectField label="Status" value={status} onChange={changeFilter(setStatus)} options={STATUS_OPTIONS} />
        <DateField label="Paid from" value={from} onChange={changeFilter(setFrom)} />
        <DateField label="Paid to" value={to} onChange={changeFilter(setTo)} />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load payments. {loadError}
        </p>
      )}

      {loading && !result ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={result?.items ?? []}
            getRowKey={(p) => p.id}
            emptyMessage={filtered ? "No payments match these filters." : "No payments yet."}
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
