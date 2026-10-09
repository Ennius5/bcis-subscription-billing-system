import { useEffect, useState } from "react";
import { AGING_BUCKET_LABELS, AGING_BUCKETS, SERVICE_TYPE_CODES, formatPesos, type AgingBucket } from "@bcis/shared";
import type { ReceivableFilterOptionsDto } from "../../../preload/index";
import { serviceTypeLabel } from "../subscribers/status";
import { Badge, type BadgeTone } from "../ui/Badge";
import { SelectField, type SelectOption } from "../ui/SelectField";

/* ------------------------------- Buckets ------------------------------- */

const BUCKET_TONE: Record<AgingBucket, BadgeTone> = {
  current: "neutral",
  days_1_30: "warning",
  days_31_60: "danger",
  days_61_90: "danger",
  days_90_plus: "danger",
};

export function bucketLabel(bucket: string): string {
  return AGING_BUCKET_LABELS[bucket as AgingBucket] ?? bucket;
}

/** Delinquency age as text plus color, never color alone. */
export function BucketBadge({ bucket }: { bucket: string }) {
  return <Badge tone={BUCKET_TONE[bucket as AgingBucket] ?? "neutral"}>{bucketLabel(bucket)}</Badge>;
}

export const BUCKET_OPTIONS: SelectOption[] = [
  { value: "", label: "Any age" },
  ...AGING_BUCKETS.map((b) => ({ value: b, label: bucketLabel(b) })),
];

/* -------------------------------- Tiles -------------------------------- */

export function MoneyTile({ label, centavos, note }: { label: string; centavos: number; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="money mt-1 text-lg font-semibold text-ink">{formatPesos(centavos)}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}

export function CountTile({ label, count, note }: { label: string; count: number; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{count}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}

/* ------------------------------- Filters ------------------------------- */

export interface ReceivableFilters {
  collectorId: string;
  areaId: string;
  planId: string;
  serviceType: string;
}

export const NO_FILTERS: ReceivableFilters = { collectorId: "", areaId: "", planId: "", serviceType: "" };

export const hasFilters = (f: ReceivableFilters) => Object.values(f).some((v) => v !== "");

/** Loads the filter choices once. If it fails, the filters still work as "All". */
export function useFilterOptions(onSessionExpired: () => void): ReceivableFilterOptionsDto | null {
  const [options, setOptions] = useState<ReceivableFilterOptionsDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.bcis.receivables.filterOptions().then((r) => {
      if (cancelled) return;
      if (r.ok) setOptions(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    });
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);
  return options;
}

const inactive = (isActive: boolean) => (isActive ? "" : " (inactive)");

interface FilterBarProps {
  value: ReceivableFilters;
  onChange: (next: ReceivableFilters) => void;
  options: ReceivableFilterOptionsDto | null;
}

/** Collector, area, plan and service type: shared by Outstanding, Overdue, Aging and candidates. */
export function FilterBar({ value, onChange, options }: FilterBarProps) {
  const set = (key: keyof ReceivableFilters) => (v: string) => onChange({ ...value, [key]: v });
  const collectorOptions: SelectOption[] = [
    { value: "", label: "All collectors" },
    ...(options?.collectors ?? []).map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}${inactive(c.isActive)}` })),
  ];
  const areaOptions: SelectOption[] = [
    { value: "", label: "All areas" },
    ...(options?.areas ?? []).map((a) => ({ value: a.id, label: `${a.name}${inactive(a.isActive)}` })),
  ];
  const planOptions: SelectOption[] = [
    { value: "", label: "All plans" },
    ...(options?.plans ?? [])
      .filter((p) => value.serviceType === "" || p.serviceType === value.serviceType)
      .map((p) => ({ value: p.id, label: `${p.code} – ${p.name}${inactive(p.isActive)}` })),
  ];
  const typeOptions: SelectOption[] = [
    { value: "", label: "All types" },
    ...SERVICE_TYPE_CODES.map((t) => ({ value: t, label: serviceTypeLabel(t) })),
  ];
  return (
    <>
      <SelectField label="Collector" value={value.collectorId} onChange={set("collectorId")} options={collectorOptions} />
      <SelectField label="Area" value={value.areaId} onChange={set("areaId")} options={areaOptions} />
      <SelectField
        label="Service type"
        value={value.serviceType}
        // A plan of another type would match nothing, so changing the type clears the plan.
        onChange={(v) => onChange({ ...value, serviceType: v, planId: "" })}
        options={typeOptions}
      />
      <SelectField label="Plan" value={value.planId} onChange={set("planId")} options={planOptions} />
    </>
  );
}
