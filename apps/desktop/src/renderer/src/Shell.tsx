import { useMemo, useState } from "react";
import { PERMISSIONS, visibleNavigation, type PermissionCode } from "@bcis/shared";
import type { SessionInfo } from "../../preload/index";
import { findItem, firstLeaf, Sidebar } from "./Sidebar";
import { PlansScreen } from "./plans/PlanScreen";
import { AreasScreen } from "./collection/AreaScreen";
import { CollectorsScreen } from "./collection/CollectorScreen";

function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value);
}

interface ShellProps {
  session: SessionInfo;
  onSignOut: () => void;
}

export function Shell({ session, onSignOut }: ShellProps) {
  // Menu visibility is a convenience only. The server enforces permissions on every request.
  const items = useMemo(
    () => visibleNavigation(session.permissions.filter(isPermissionCode)),
    [session.permissions],
  );
    const permissions = useMemo(
    () => session.permissions.filter(isPermissionCode),
    [session.permissions],
  );
  const [activeId, setActiveId] = useState<string | null>(() => firstLeaf(items)?.id ?? null);
  const active = activeId ? findItem(items, activeId) : null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between bg-navy px-6 py-3 text-white">
        <span className="font-semibold">BCIS Billing</span>
        <span className="flex items-center gap-4 text-sm">
          {session.user.fullName}
          <button
            onClick={onSignOut}
            className="rounded border border-white/40 px-3 py-1 hover:bg-white/10"
          >
            Sign out
          </button>
        </span>
      </header>

      <div className="flex min-h-0 flex-1 border-t border-white/10">
        {items.length > 0 && <Sidebar items={items} activeId={activeId} onSelect={setActiveId} />}
        <main className="flex-1 overflow-y-auto p-8">
          {!active ? (
            <p className="text-muted">
              Your account has no assigned permissions. Please contact the administrator.
            </p>
          ) : active.id === "subscribers.plans" ? (
            <PlansScreen permissions={permissions} onSessionExpired={onSignOut} />
          ) : active.id === "collections.collectors" ? (
            <CollectorsScreen permissions={permissions} onSessionExpired={onSignOut} />
          ) : active.id === "collections.areas" ? (
            <AreasScreen permissions={permissions} onSessionExpired={onSignOut} />
          ) : (

            <>
              <h1 className="text-xl font-semibold text-navy">{active.label}</h1>
              <p className="mt-2 text-muted">This screen has not been built yet.</p>
            </>
          )
          }
        </main>
      </div>
    </div>
  );
}