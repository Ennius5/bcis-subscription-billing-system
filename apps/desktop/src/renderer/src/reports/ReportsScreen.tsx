import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { BillingVsCollectionScreen } from "./BillingVsCollectionScreen";
import { CollectionsReportScreen } from "./CollectionsReportScreen";
import { ExceptionsScreen } from "./ExceptionsScreen";
import { MasterListScreen } from "./MasterListScreen";
import { RevenueScreen } from "./RevenueScreen";

type ReportTab = "collections" | "billing" | "revenue" | "subscribers" | "exceptions";

const TABS: { id: ReportTab; label: string }[] = [
  { id: "collections", label: "Collections" },
  { id: "billing", label: "Billing vs collection" },
  { id: "revenue", label: "Revenue" },
  { id: "subscribers", label: "Subscriber master list" },
  { id: "exceptions", label: "Adjustments & reversals" },
];

interface ReportsScreenProps {
  permissions: readonly PermissionCode[];
  onOpenSubscriber: (id: string) => void;
  onSessionExpired: () => void;
}

/** Reports (report.view). One tab per report; export buttons need report.export. */
export function ReportsScreen({ permissions, onOpenSubscriber, onSessionExpired }: ReportsScreenProps) {
  const [tab, setTab] = useState<ReportTab>("collections");
  const canExport = permissions.includes("report.export");
  return (
    <div>
      <h1 className="mb-3 text-xl font-semibold text-navy">Reports</h1>
      <div role="tablist" aria-label="Report" className="mb-4 flex gap-1">
        {TABS.map((t) => (
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
      {tab === "collections" && <CollectionsReportScreen canExport={canExport} onSessionExpired={onSessionExpired} />}
      {tab === "billing" && <BillingVsCollectionScreen canExport={canExport} onSessionExpired={onSessionExpired} />}
      {tab === "revenue" && <RevenueScreen canExport={canExport} onSessionExpired={onSessionExpired} />}
      {tab === "subscribers" && (
        <MasterListScreen
          canExport={canExport}
          {...(permissions.includes("subscriber.view") ? { onOpenSubscriber } : {})}
          onSessionExpired={onSessionExpired}
        />
      )}
      {tab === "exceptions" && <ExceptionsScreen canExport={canExport} onSessionExpired={onSessionExpired} />}
    </div>
  );
}
