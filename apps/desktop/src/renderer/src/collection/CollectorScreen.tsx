import { useEffect, useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import type { CollectorDto } from "../../../preload/index";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { CollectorForm, type CollectorFormMode } from "./CollectorForm";

interface CollectorsScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

export function CollectorsScreen({ permissions, onSessionExpired }: CollectorsScreenProps) {
  // Hiding controls is cosmetic. The server enforces collection.manage on every request.
  const canManage = permissions.includes("collection.manage");

  const [collectors, setCollectors] = useState<CollectorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<CollectorFormMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.collectors.list(includeInactive).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setCollectors(result.data);
        setLoadError(null);
      } else if (result.code === "UNAUTHENTICATED") {
        onSessionExpired();
        return;
      } else {
        setLoadError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [includeInactive, reloadKey, onSessionExpired]);

  const columns: Column<CollectorDto>[] = [
    { key: "code", header: "Code", render: (c) => <span className="font-medium">{c.code}</span> },
    { key: "fullName", header: "Full name", render: (c) => c.fullName },
    { key: "contact", header: "Contact number", render: (c) => c.contactNumber ?? "—" },
    { key: "login", header: "Login", render: (c) => c.username ?? "No login" },
    {
      key: "status",
      header: "Status",
      render: (c) => (
        <Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "Active" : "Inactive"}</Badge>
      ),
    },
  ];
  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      render: (c) => (
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
          onClick={() => setForm({ kind: "edit", collector: c })}
        >
          Edit
        </button>
      ),
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-navy">Collectors</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            Show inactive
          </label>
          {canManage && (
            <button
              className="rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90"
              onClick={() => setForm({ kind: "create" })}
            >
              New collector
            </button>
          )}
        </div>
      </div>

      {form && canManage && (
        <CollectorForm
          key={form.kind === "edit" ? form.collector.id : "new"}
          mode={form}
          onCancel={() => setForm(null)}
          onExpired={onSessionExpired}
          onSaved={() => {
            setForm(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {loadError && (
        <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load collectors. {loadError}
        </p>
      )}

      {loading && collectors.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <DataTable
          columns={columns}
          rows={collectors}
          getRowKey={(c) => c.id}
          emptyMessage={
            includeInactive
              ? "No collectors have been created yet."
              : "No active collectors. Try “Show inactive”."
          }
        />
      )}
    </div>
  );
}