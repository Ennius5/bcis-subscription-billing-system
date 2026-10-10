import { useEffect, useState } from "react";
import { SUBSCRIBER_STATUSES, SUBSCRIBER_STATUS_LABELS, formatPesos } from "@bcis/shared";
import type { MasterListDto, MasterListQuery, MasterListRowDto } from "../../../preload/index";
import { CountTile, MoneyTile, useFilterOptions } from "../receivables/receivableParts";
import { RowError } from "../subscribers/ProfileParts";
import { StatusBadge } from "../subscribers/status";
import { DataTable, type Column } from "../ui/DataTable";
import { ExportButtons } from "../ui/ExportButtons";
import { Pager } from "../ui/Pager";
import { SelectField } from "../ui/SelectField";

const STATUS_OPTIONS = [
  { value: "", label: "All except archived" },
  ...SUBSCRIBER_STATUSES.map((st) => ({ value: st, label: SUBSCRIBER_STATUS_LABELS[st] })),
];
const inactive = (isActive: boolean) => (isActive ? "" : " (inactive)");
/** "–" for a missing value; blank in the totals row (which has no subscriber id). */
const text = (r: MasterListRowDto, value: string | null) => (r.subscriberId ? (value ?? "–") : "");

interface MasterListScreenProps {
  canExport: boolean;
  /** Set when the user may open profiles (subscriber.view). */
  onOpenSubscriber?: (id: string) => void;
  onSessionExpired: () => void;
}

/** Every subscriber with area, collector, address, contact, plans, monthly rate and balance. */
export function MasterListScreen({ canExport, onOpenSubscriber, onSessionExpired }: MasterListScreenProps) {
  const options = useFilterOptions(onSessionExpired);
  const [query, setQuery] = useState<Required<Omit<MasterListQuery, "page">>>({ status: "", areaId: "", collectorId: "" });
  const [page, setPage] = useState(1);
  const [list, setList] = useState<MasterListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // A new filter starts again at page 1.
  const filter = (next: typeof query) => {
    setQuery(next);
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.reports.masterList({ ...query, page }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setList(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [query, page, onSessionExpired]);

  const columns: Column<MasterListRowDto>[] = [
    { key: "account", header: "Account", render: (r) => r.accountNumber },
    {
      key: "name",
      header: "Name",
      render: (r) =>
        onOpenSubscriber && r.subscriberId ? (
          <button className="font-medium text-accent hover:underline" onClick={() => onOpenSubscriber(r.subscriberId)}>
            {r.fullName}
          </button>
        ) : (
          r.fullName
        ),
    },
    { key: "status", header: "Status", render: (r) => (r.subscriberId ? <StatusBadge status={r.status} /> : "") },
    { key: "address", header: "Address", render: (r) => text(r, r.address) },
    { key: "contact", header: "Contact", render: (r) => text(r, r.contact) },
    { key: "area", header: "Area", render: (r) => text(r, r.area) },
    { key: "collector", header: "Collector", render: (r) => text(r, r.collector) },
    { key: "plans", header: "Plans", render: (r) => text(r, r.plans) },
    { key: "services", header: "Active svc", align: "right", render: (r) => r.activeServiceCount },
    { key: "monthly", header: "Monthly rate", align: "right", render: (r) => formatPesos(r.monthlyRateCentavos) },
    { key: "balance", header: "Balance", align: "right", render: (r) => formatPesos(r.balanceCentavos) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid grid-cols-3 gap-3">
          <SelectField label="Status" value={query.status} options={STATUS_OPTIONS} onChange={(status) => filter({ ...query, status })} />
          <SelectField
            label="Area"
            value={query.areaId}
            options={[
              { value: "", label: "All areas" },
              ...(options?.areas ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}${inactive(a.isActive)}` })),
            ]}
            onChange={(areaId) => filter({ ...query, areaId })}
          />
          <SelectField
            label="Collector"
            value={query.collectorId}
            options={[
              { value: "", label: "All collectors" },
              ...(options?.collectors ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.fullName}${inactive(c.isActive)}` })),
            ]}
            onChange={(collectorId) => filter({ ...query, collectorId })}
          />
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportMasterList(query, format)}
            onExpired={onSessionExpired}
            disabled={!list}
          />
        )}
      </div>

      {error && <RowError message={`Could not load the master list. ${error}`} />}
      {!list && !error && <p className="text-muted">Loading…</p>}

      {list && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <CountTile
              label="Subscribers"
              count={list.totals.subscriberCount}
              note={SUBSCRIBER_STATUSES.filter((st) => (list.statusCounts[st] ?? 0) > 0)
                .map((st) => `${list.statusCounts[st]} ${SUBSCRIBER_STATUS_LABELS[st].toLowerCase()}`)
                .join(", ")}
            />
            <CountTile label="Active services" count={list.totals.activeServiceCount} />
            <MoneyTile label="Monthly rates" centavos={list.totals.monthlyRateCentavos} note="Active services" />
            <MoneyTile label="Balance" centavos={list.totals.balanceCentavos} note="Owed less advance credit" />
          </div>
          <DataTable
            columns={columns}
            rows={list.rows}
            getRowKey={(r) => r.subscriberId}
            emptyMessage="No subscribers match."
            totals={{
              subscriberId: "",
              accountNumber: "Total",
              fullName: `${list.totals.subscriberCount} subscribers, all pages`,
              status: "",
              area: null,
              collector: null,
              address: null,
              contact: null,
              plans: null,
              activeServiceCount: list.totals.activeServiceCount,
              monthlyRateCentavos: list.totals.monthlyRateCentavos,
              balanceCentavos: list.totals.balanceCentavos,
            }}
          />
          <Pager page={list.page} pageSize={list.pageSize} total={list.total} loading={loading} onPage={setPage} />
        </>
      )}
    </div>
  );
}
