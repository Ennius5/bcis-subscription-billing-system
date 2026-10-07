import { useEffect, useState } from "react";
import { formatPesos, type PermissionCode, type ServiceTypeCode } from "@bcis/shared";
import type { PlanDto } from "../../../preload/index";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { PlanForm, TYPE_LABEL, type PlanFormMode } from "./PlanForm";

interface PlansScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

function attributes(plan: PlanDto): string {
  const parts: string[] = [];
  if (plan.speedMbps != null) parts.push(`${plan.speedMbps} Mbps`);
  if (plan.channelCount != null) parts.push(`${plan.channelCount} channels`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

export function PlansScreen({ permissions, onSessionExpired }: PlansScreenProps) {
  // Hiding controls is cosmetic. The server enforces plan.manage on every request.
  const canManage = permissions.includes("plan.manage");

  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<PlanFormMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.bcis.plans.list(includeInactive).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setPlans(result.data);
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

  const columns: Column<PlanDto>[] = [
    { key: "code", header: "Code", render: (p) => <span className="font-medium">{p.code}</span> },
    { key: "name", header: "Name", render: (p) => p.name },
    {
      key: "type",
      header: "Type",
      render: (p) => TYPE_LABEL[p.serviceType as ServiceTypeCode] ?? p.serviceType,
    },
    { key: "attrs", header: "Speed / Channels", render: attributes },
    { key: "price", header: "Monthly price", align: "right", render: (p) => formatPesos(p.priceCentavos) },
    {
      key: "install",
      header: "Installation",
      align: "right",
      render: (p) => formatPesos(p.installationFeeCentavos),
    },
    {
      key: "recon",
      header: "Reconnection",
      align: "right",
      render: (p) => formatPesos(p.reconnectionFeeCentavos),
    },
    {
      key: "status",
      header: "Status",
      render: (p) => <Badge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "Active" : "Inactive"}</Badge>,
    },
  ];
  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      render: (p) => (
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
          onClick={() => setForm({ kind: "edit", plan: p })}
        >
          Edit
        </button>
      ),
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-navy">Service Plans</h1>
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
              New plan
            </button>
          )}
        </div>
      </div>

      {form && canManage && (
        <PlanForm
          key={form.kind === "edit" ? form.plan.id : "new"}
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
          Could not load plans. {loadError}
        </p>
      )}

      {loading && plans.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <DataTable
          columns={columns}
          rows={plans}
          getRowKey={(p) => p.id}
          emptyMessage={
            includeInactive ? "No plans have been created yet." : "No active plans. Try “Show inactive”."
          }
        />
      )}
    </div>
  );
}