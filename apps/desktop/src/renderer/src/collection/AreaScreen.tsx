import { useEffect, useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import type { AreaDto } from "../../../preload/index";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { AreaForm, type AreaFormMode } from "./AreaForm";

interface AreasScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

export function AreasScreen({ permissions, onSessionExpired }: AreasScreenProps) {
  // Hiding controls is cosmetic. The server enforces collection.manage on every request.
  const canManage = permissions.includes("collection.manage");

  const [areas, setAreas] = useState<AreaDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<AreaFormMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.collectionAreas.list(includeInactive).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAreas(result.data);
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

  const columns: Column<AreaDto>[] = [
    { key: "code", header: "Code", render: (a) => <span className="font-medium">{a.code}</span> },
    { key: "name", header: "Name", render: (a) => a.name },
    { key: "description", header: "Description", render: (a) => a.description ?? "—" },
    {
      key: "status",
      header: "Status",
      render: (a) => (
        <Badge tone={a.isActive ? "success" : "neutral"}>{a.isActive ? "Active" : "Inactive"}</Badge>
      ),
    },
  ];
  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      render: (a) => (
        <button
          className="btn btn-secondary btn-xs"
          onClick={() => setForm({ kind: "edit", area: a })}
        >
          Edit
        </button>
      ),
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-navy">Areas &amp; Routes</h1>
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
              className="btn btn-accent"
              onClick={() => setForm({ kind: "create" })}
            >
              New area
            </button>
          )}
        </div>
      </div>

      {form && canManage && (
        <AreaForm
          key={form.kind === "edit" ? form.area.id : "new"}
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
        <p role="alert" className="alert alert-danger mb-4">
          Could not load collection areas. {loadError}
        </p>
      )}

      {loading && areas.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <DataTable
          columns={columns}
          rows={areas}
          getRowKey={(a) => a.id}
          emptyMessage={
            includeInactive
              ? "No collection areas have been created yet."
              : "No active areas. Try “Show inactive”."
          }
        />
      )}
    </div>
  );
}