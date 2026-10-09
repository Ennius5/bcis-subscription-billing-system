import { useEffect, useMemo, useRef, useState } from "react";
import { PERMISSIONS, visibleNavigation, type PermissionCode } from "@bcis/shared";
import type { SessionInfo } from "../../preload/index";
import { findItem, firstLeaf, Sidebar } from "./Sidebar";
import { PlansScreen } from "./plans/PlanScreen";
import { AreasScreen } from "./collection/AreaScreen";
import { CollectorsScreen } from "./collection/CollectorScreen";
import { NewSubscriberScreen } from "./subscribers/NewSubscriberScreen";
import { SearchResults } from "./subscribers/SearchResults";
import { SubscribersScreen } from "./subscribers/SubscribersScreen";
import { ServiceAccountsScreen } from "./service-accounts/ServiceAccountsScreen";
import { GenerateBillingScreen } from "./billing/GenerateBillingScreen";
import { currentMonth } from "./billing/invoiceStatus";
import { InvoicesScreen } from "./billing/InvoicesScreen";
import { ReceivePaymentScreen } from "./payments/ReceivePaymentScreen";

const SEARCH_DELAY_MS = 300;

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
  // Set when a profile should open straight away (after New Subscriber or from search).
  // openRequest remounts All Subscribers so it opens that profile even if it is already showing.
  const [openSubscriberId, setOpenSubscriberId] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState(0);

  // Global search. Results replace the main area while the box has text; the screen
  // underneath stays mounted, so Esc returns to it exactly as it was.
  const canSearch = permissions.includes("subscriber.view");
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searching = searchText.trim() !== "";

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchText.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Ctrl+K jumps to the search box from anywhere.
  useEffect(() => {
    if (!canSearch) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSearch]);

  function clearSearch() {
    setSearchText("");
    setSearchQuery("");
  }

  function selectScreen(id: string) {
    clearSearch();
    setOpenSubscriberId(null);
    setActiveId(id);
  }

  function openSubscriber(id: string) {
    clearSearch();
    setOpenSubscriberId(id);
    setOpenRequest((n) => n + 1);
    setActiveId("subscribers.all");
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-6 bg-navy px-6 py-3 text-white">
        <span className="font-semibold">BCIS Billing</span>
        {canSearch && (
          <input
            ref={searchInput}
            type="search"
            aria-label="Search subscribers"
            placeholder="Search account, name, phone or address…  (Ctrl+K)"
            className="w-full max-w-xl rounded border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 focus:border-white/50 focus:outline-none"
            value={searchText}
            maxLength={100}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                clearSearch();
                e.currentTarget.blur();
              }
            }}
          />
        )}
        <span className="flex shrink-0 items-center gap-4 text-sm">
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
        {items.length > 0 && <Sidebar items={items} activeId={activeId} onSelect={selectScreen} />}
        <main className="flex-1 overflow-y-auto p-8">
          {searching && (
            <SearchResults query={searchQuery} onOpen={openSubscriber} onSessionExpired={onSignOut} />
          )}
          <div hidden={searching}>
            {!active ? (
              <p className="text-muted">
                Your account has no assigned permissions. Please contact the administrator.
              </p>
            ) : active.id === "subscribers.all" ? (
              <SubscribersScreen
                key={openRequest}
                permissions={permissions}
                initialOpenId={openSubscriberId}
                onSessionExpired={onSignOut}
              />
            ) : active.id === "subscribers.new" ? (
              <NewSubscriberScreen onCreated={openSubscriber} onSessionExpired={onSignOut} />
            ) : active.id === "subscribers.services" ? (
              <ServiceAccountsScreen permissions={permissions} onSessionExpired={onSignOut} />
            ) : active.id === "billing.current" ? (
              <InvoicesScreen
                title="Current Billing"
                initialPeriod={currentMonth()}
                permissions={permissions}
                onSessionExpired={onSignOut}
              />
            ) : active.id === "billing.generate" ? (
              <GenerateBillingScreen permissions={permissions} onSessionExpired={onSignOut} />
            ) : active.id === "billing.invoices" ? (
              <InvoicesScreen title="Invoices" initialPeriod="" permissions={permissions} onSessionExpired={onSignOut} />
            ) : active.id === "payments.receive" ? (
              <ReceivePaymentScreen permissions={permissions} onSessionExpired={onSignOut} />
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
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
