import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { BatchList } from "./BatchesScreen";
import { BatchView } from "./BatchView";

// The end of a collector's round, step by step: count the cash, reconcile, close.
const TABS = [
  { status: "submitted", label: "Collector back: count cash", empty: "No submitted batches waiting for their cash." },
  { status: "remitted", label: "Cash recorded: reconcile", empty: "No remitted batches waiting to be reconciled." },
  { status: "reconciled", label: "Reconciled: close", empty: "No reconciled batches waiting to be closed." },
] as const;

interface RemittanceScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Remittance: the batches whose cash still has to be counted, reconciled or closed. */
export function RemittanceScreen({ permissions, onSessionExpired }: RemittanceScreenProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]["status"]>("submitted");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const current = TABS.find((t) => t.status === tab)!;

  return (
    <>
      <div hidden={openId !== null}>
        <h1 className="mb-4 text-xl font-semibold text-navy">Remittance</h1>
        <div role="tablist" aria-label="Remittance step" className="mb-4 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.status}
              role="tab"
              aria-selected={tab === t.status}
              className={`rounded px-3 py-1 text-sm ${
                tab === t.status ? "bg-navy text-white" : "border border-slate-300 text-ink hover:bg-slate-50"
              }`}
              onClick={() => setTab(t.status)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <BatchList
          key={tab}
          fixedStatus={tab}
          emptyMessage={current.empty}
          reloadKey={reloadKey}
          onOpen={setOpenId}
          onSessionExpired={onSessionExpired}
        />
      </div>
      {openId && (
        <BatchView
          key={openId}
          batchId={openId}
          skipped={[]}
          permissions={permissions}
          backLabel="Back to remittance"
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // the batch probably moved to the next step
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}
