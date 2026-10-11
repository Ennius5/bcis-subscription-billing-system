import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { ReconnectionList } from "../receivables/SuspensionScreen";
import { ServiceAccountList } from "./ServiceAccountList";
import { ServiceAccountScreen } from "./ServiceAccountScreen";

type Tab = "all" | "pending" | "suspended" | "reconnections";

const BACK_LABELS: Record<Tab, string> = {
  all: "Back to all service accounts",
  pending: "Back to awaiting installation",
  suspended: "Back to suspended services",
  reconnections: "Back to reconnections",
};

interface ServicesHubProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/**
 * Services (service.view): the field work list and the technician's home screen. Services
 * waiting to be installed, suspended services, and reconnections still in progress, each
 * one click from the service. Reconnections need suspension.manage, as on the server.
 */
export function ServicesHub({ permissions, onSessionExpired }: ServicesHubProps) {
  const canControl = permissions.includes("suspension.manage");
  const [tab, setTab] = useState<Tab>("pending");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const tabs: { id: Tab; label: string }[] = [
    { id: "all", label: "All service accounts" },
    { id: "pending", label: "Awaiting installation" },
    { id: "suspended", label: "Suspended" },
    ...(canControl ? [{ id: "reconnections" as const, label: "Reconnections in progress" }] : []),
  ];

  return (
    <>
      {/* Every tab stays mounted while a service is open, so filters and pages survive the round trip. */}
      <div hidden={openId !== null}>
        <div role="tablist" aria-label="Services view" className="mb-4 flex gap-1">
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
        <div hidden={tab !== "all"}>
          <ServiceAccountList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
        </div>
        <div hidden={tab !== "pending"}>
          <ServiceAccountList
            title="Awaiting Installation"
            description="New services not yet installed. Open one and activate it once the line is connected."
            fixedStatus="pending"
            reloadKey={reloadKey}
            onOpen={setOpenId}
            onSessionExpired={onSessionExpired}
          />
        </div>
        <div hidden={tab !== "suspended"}>
          <ServiceAccountList
            title="Suspended Services"
            description="Services cut for non-payment or on request. Open one to see the suspension and request a reconnection."
            fixedStatus="suspended"
            reloadKey={reloadKey}
            onOpen={setOpenId}
            onSessionExpired={onSessionExpired}
          />
        </div>
        {canControl && (
          <div hidden={tab !== "reconnections"}>
            <ReconnectionList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
          </div>
        )}
      </div>
      {openId && (
        <ServiceAccountScreen
          key={openId}
          serviceAccountId={openId}
          canManage={permissions.includes("service.manage")}
          canControl={canControl}
          backLabel={BACK_LABELS[tab]}
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // an activation, suspension or reconnection moves it between tabs
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}
