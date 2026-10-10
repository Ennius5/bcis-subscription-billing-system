import { Fragment, useEffect, useState } from "react";
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  type AuditCategory,
  type PermissionCode,
  addDays,
  auditCategory,
  auditLogQuerySchema,
  userActivityQuerySchema,
} from "@bcis/shared";
import type {
  AuditFilterOptionsDto,
  AuditLogPageDto,
  AuditLogQuery,
  AuditLogRowDto,
  DateRangeQuery,
  UserActivityDto,
  UserActivityRowDto,
} from "../../../preload/index";
import { todayLocal } from "../payments/paymentLabels";
import { CountTile } from "../receivables/receivableParts";
import { formatDateTime, RowError } from "../subscribers/ProfileParts";
import { DataTable, type Column } from "../ui/DataTable";
import { DateField } from "../ui/DateField";
import { ExportButtons } from "../ui/ExportButtons";
import { Pager } from "../ui/Pager";
import { SelectField } from "../ui/SelectField";

type Tab = "log" | "activity";

interface AuditLogScreenProps {
  permissions: readonly PermissionCode[];
  onOpenSubscriber: (id: string) => void;
  onSessionExpired: () => void;
}

/** Administration > Audit Log (audit.view): the read-only log, and user activity. */
export function AuditLogScreen({ permissions, onOpenSubscriber, onSessionExpired }: AuditLogScreenProps) {
  const [tab, setTab] = useState<Tab>("log");
  const tabs: { id: Tab; label: string }[] = [
    { id: "log", label: "Log" },
    { id: "activity", label: "User activity" },
  ];
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-navy">Audit Log</h1>
      <p className="mb-3 text-sm text-muted">Every recorded change, newest first. Audit entries cannot be edited or deleted.</p>
      <div role="tablist" aria-label="Audit view" className="mb-4 flex gap-1">
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
      {tab === "log" ? (
        <LogView
          {...(permissions.includes("subscriber.view") ? { onOpenSubscriber } : {})}
          onSessionExpired={onSessionExpired}
        />
      ) : (
        <ActivityView canExport={permissions.includes("report.export")} onSessionExpired={onSessionExpired} />
      )}
    </div>
  );
}

/* ---------------------------------- Log ---------------------------------- */

/** How a stored value reads in the change table. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Field / before / after, from the old and new values recorded with the entry. */
function Changes({ row }: { row: AuditLogRowDto }) {
  const before = isObject(row.oldValues) ? row.oldValues : {};
  const after = isObject(row.newValues) ? row.newValues : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  if (keys.length === 0) return <p className="text-sm text-muted">No values were recorded with this entry.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="w-1/4 py-1 pr-3 font-medium">Field</th>
          <th className="w-3/8 py-1 pr-3 font-medium">Before</th>
          <th className="w-3/8 py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="align-top">
            <td className="py-1 pr-3 font-medium">{k}</td>
            <td className="break-all py-1 pr-3 text-muted">{k in before ? valueText(before[k]) : ""}</td>
            <td className="break-all py-1">{k in after ? valueText(after[k]) : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EMPTY_LOG_FILTERS = { actorUserId: "", category: "", action: "", entityType: "", entityId: "" };

function LogView({ onOpenSubscriber, onSessionExpired }: { onOpenSubscriber?: (id: string) => void; onSessionExpired: () => void }) {
  const [options, setOptions] = useState<AuditFilterOptionsDto | null>(null);
  const [range, setRange] = useState({ from: addDays(todayLocal(), -6), to: todayLocal() });
  const [filters, setFilters] = useState(EMPTY_LOG_FILTERS);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AuditLogPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void window.bcis.audit.filterOptions().then((r) => {
      if (cancelled) return;
      if (r.ok) setOptions(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    });
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  const query: AuditLogQuery = {
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "")),
    page,
  };
  const parsed = auditLogQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the filters.");
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    setLoading(true);
    void window.bcis.audit.list(JSON.parse(queryKey) as AuditLogQuery).then((r) => {
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
  }, [queryKey, queryProblem, onSessionExpired]);

  // Any filter change starts again at page 1.
  const change = (next: Partial<typeof filters>) => {
    setFilters({ ...filters, ...next });
    setPage(1);
  };
  const changeRange = (next: Partial<typeof range>) => {
    setRange({ ...range, ...next });
    setPage(1);
  };
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const actionOptions = (options?.actions ?? []).filter((a) => !filters.category || auditCategory(a) === filters.category);
  const th = "sticky top-0 border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-muted";
  const td = "px-3 py-2 align-top";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-6 gap-3">
        <DateField label="From" value={range.from} onChange={(from) => changeRange({ from })} hint="Blank for the beginning." />
        <DateField label="To" value={range.to} onChange={(to) => changeRange({ to })} hint="Blank for today." />
        <SelectField
          label="User"
          value={filters.actorUserId}
          options={[
            { value: "", label: "All users" },
            ...(options?.users ?? []).map((u) => ({ value: u.id, label: `${u.username}${u.isActive ? "" : " (inactive)"}` })),
          ]}
          onChange={(actorUserId) => change({ actorUserId })}
        />
        <SelectField
          label="Area"
          value={filters.category}
          options={[{ value: "", label: "All areas" }, ...AUDIT_CATEGORIES.map((c) => ({ value: c, label: AUDIT_CATEGORY_LABELS[c] }))]}
          onChange={(category) => change({ category, action: "" })}
        />
        <SelectField
          label="Action"
          value={filters.action}
          options={[{ value: "", label: "All actions" }, ...actionOptions.map((a) => ({ value: a, label: a }))]}
          onChange={(action) => change({ action })}
        />
        <SelectField
          label="Record type"
          value={filters.entityType}
          options={[{ value: "", label: "All types" }, ...(options?.entityTypes ?? []).map((t) => ({ value: t, label: t }))]}
          onChange={(entityType) => change({ entityType, entityId: "" })}
        />
      </div>

      {filters.entityId && (
        <p className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          Showing only {filters.entityType} {filters.entityId}.
          <button className="text-accent hover:underline" onClick={() => change({ entityType: "", entityId: "" })}>
            Show all records
          </button>
        </p>
      )}
      {queryProblem && <RowError message={queryProblem} />}
      {error && <RowError message={`Could not load the audit log. ${error}`} />}
      {!result && !error && !queryProblem && <p className="text-muted">Loading…</p>}

      {result && (
        <>
          <div className="overflow-auto rounded-lg border border-slate-200 bg-surface">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>User</th>
                  <th className={th}>Action</th>
                  <th className={th}>Record</th>
                  <th className={th}>Reason</th>
                  <th className={th}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted">
                      No audit entries match these filters.
                    </td>
                  </tr>
                ) : (
                  result.items.map((row) => (
                    <Fragment key={row.id}>
                      <tr className="border-b border-slate-100 hover:bg-slate-50">
                        <td className={`${td} whitespace-nowrap`}>{formatDateTime(row.occurredAt)}</td>
                        <td className={td}>
                          {row.actor ? (
                            <>
                              <span className="font-medium">{row.actor.username}</span>
                              <span className="block text-xs text-muted">{row.actor.fullName}</span>
                            </>
                          ) : (
                            <span className="text-muted">No user</span>
                          )}
                        </td>
                        <td className={td}>
                          <span className="font-medium">{row.action}</span>
                          <span className="block text-xs text-muted">{AUDIT_CATEGORY_LABELS[auditCategory(row.action)]}</span>
                        </td>
                        <td className={td}>
                          <span>{row.entityType}</span>
                          {row.entityId && (
                            <span className="block text-xs">
                              <button
                                className="text-accent hover:underline"
                                title="Show every entry for this record"
                                onClick={() => change({ entityType: row.entityType, entityId: row.entityId ?? "" })}
                              >
                                History
                              </button>
                              {row.entityType === "subscriber" && onOpenSubscriber && (
                                <>
                                  {" · "}
                                  <button className="text-accent hover:underline" onClick={() => onOpenSubscriber(row.entityId!)}>
                                    Open profile
                                  </button>
                                </>
                              )}
                            </span>
                          )}
                        </td>
                        <td className={td}>{row.reason ?? <span className="text-muted">—</span>}</td>
                        <td className={`${td} text-right`}>
                          <button
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
                            aria-expanded={expanded.has(row.id)}
                            onClick={() => toggle(row.id)}
                          >
                            {expanded.has(row.id) ? "Hide" : "Details"}
                          </button>
                        </td>
                      </tr>
                      {expanded.has(row.id) && (
                        <tr className="border-b border-slate-100 bg-slate-50/60">
                          <td colSpan={6} className="px-6 py-3">
                            <Changes row={row} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager page={result.page} pageSize={result.pageSize} total={result.total} loading={loading} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/* ------------------------------ User activity ------------------------------ */

const firstOfMonth = () => `${todayLocal().slice(0, 8)}01`;

function ActivityView({ canExport, onSessionExpired }: { canExport: boolean; onSessionExpired: () => void }) {
  const [query, setQuery] = useState<DateRangeQuery>({ from: firstOfMonth(), to: todayLocal() });
  const [report, setReport] = useState<UserActivityDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = userActivityQuerySchema.safeParse(query);
  const queryProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the dates.");

  useEffect(() => {
    if (queryProblem) return;
    let cancelled = false;
    void window.bcis.reports.userActivity(query).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setReport(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [query, queryProblem, onSessionExpired]);

  const count = (n: number | undefined) => (n ? n.toLocaleString() : "–");
  const columns: Column<UserActivityRowDto>[] = [
    {
      key: "user",
      header: "User",
      render: (u) => (
        <>
          <span className="font-medium">{u.username}</span>
          {!u.isActive && u.userId && <span className="ml-1 text-xs text-muted">(inactive)</span>}
          <span className="block text-xs text-muted">{u.roles ? `${u.fullName} · ${u.roles}` : u.fullName}</span>
        </>
      ),
    },
    { key: "logins", header: "Sign-ins", align: "right", render: (u) => count(u.loginCount) },
    { key: "actions", header: "Actions", align: "right", render: (u) => <strong>{count(u.actionCount)}</strong> },
    ...AUDIT_CATEGORIES.map((c) => ({
      key: c,
      header: AUDIT_CATEGORY_LABELS[c],
      align: "right" as const,
      render: (u: UserActivityRowDto) => count(u.byCategory[c]),
    })),
    { key: "last", header: "Last action", render: (u) => (u.lastActionAt ? formatDateTime(u.lastActionAt) : "–") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="w-44">
            <DateField label="From" value={query.from} onChange={(from) => setQuery({ ...query, from })} required />
          </div>
          <div className="w-44">
            <DateField label="To" value={query.to} onChange={(to) => setQuery({ ...query, to })} required />
          </div>
        </div>
        {canExport && (
          <ExportButtons
            onExport={(format) => window.bcis.reports.exportUserActivity(query, format)}
            onExpired={onSessionExpired}
            disabled={queryProblem !== null || !report}
          />
        )}
      </div>

      {queryProblem && <RowError message={queryProblem} />}
      {error && <RowError message={`Could not load user activity. ${error}`} />}
      {!report && !error && !queryProblem && <p className="text-muted">Loading…</p>}

      {report && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <CountTile label="Users listed" count={report.users.length} note="Active users and anyone who acted" />
            <CountTile label="Sign-ins" count={report.totals.loginCount} />
            <CountTile label="Audited actions" count={report.totals.actionCount} />
            <CountTile label="Exports" count={report.totals.byCategory.exports ?? 0} note="Reports and statements saved" />
          </div>
          <DataTable
            columns={columns}
            rows={report.users}
            getRowKey={(u) => u.userId ?? "none"}
            emptyMessage="No users."
            totals={{
              userId: "total",
              username: "Total",
              fullName: "",
              roles: null,
              isActive: true,
              loginCount: report.totals.loginCount,
              lastLoginAt: null,
              actionCount: report.totals.actionCount,
              byCategory: report.totals.byCategory,
              lastActionAt: null,
            }}
          />
          <section>
            <h2 className="mb-2 text-sm font-semibold text-navy">By action</h2>
            <DataTable
              columns={[
                { key: "action", header: "Action", render: (a) => a.action },
                { key: "area", header: "Area", render: (a) => AUDIT_CATEGORY_LABELS[a.category as AuditCategory] ?? a.category },
                { key: "count", header: "Times", align: "right", render: (a) => a.count.toLocaleString() },
                { key: "users", header: "Users", align: "right", render: (a) => a.userCount },
              ]}
              rows={report.actions}
              getRowKey={(a) => a.action}
              emptyMessage="No audited actions in this period."
            />
          </section>
          <p className="text-xs text-muted">
            Sign-ins are sessions started in the period. Actions are audit log entries; viewing screens is not recorded.
          </p>
        </>
      )}
    </div>
  );
}
