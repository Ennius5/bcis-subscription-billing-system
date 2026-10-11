import type { PermissionCode } from "@bcis/shared";

/** The Subscriber Profile tabs of spec 4.3, in the spec's order. */
export const PROFILE_TABS = [
  "overview",
  "services",
  "billing",
  "payments",
  "ledger",
  "collection",
  "history",
  "documents",
  "audit",
] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

const LABELS: Record<ProfileTab, string> = {
  overview: "Overview",
  services: "Services",
  billing: "Billing",
  payments: "Payments",
  ledger: "Ledger",
  collection: "Collection",
  history: "Service history",
  documents: "Documents",
  audit: "Audit",
};

/**
 * Who sees which tab. Cosmetic like every hidden control: each tab's data comes from a route
 * that checks the same permission on the server.
 */
const VISIBLE: Record<ProfileTab, (has: (p: PermissionCode) => boolean) => boolean> = {
  overview: () => true,
  services: (has) => has("service.view"),
  billing: (has) => has("billing.view"),
  payments: (has) => has("payment.view"),
  ledger: (has) => has("billing.view"),
  collection: (has) => has("collection.view"),
  history: () => true,
  documents: (has) => has("billing.view") || has("payment.view"),
  audit: (has) => has("audit.view"),
};

export function visibleProfileTabs(permissions: readonly PermissionCode[]): ProfileTab[] {
  const has = (p: PermissionCode) => permissions.includes(p);
  return PROFILE_TABS.filter((tab) => VISIBLE[tab](has));
}

interface TabBarProps {
  tabs: readonly ProfileTab[];
  active: ProfileTab;
  onSelect: (tab: ProfileTab) => void;
}

export function ProfileTabBar({ tabs, active, onSelect }: TabBarProps) {
  return (
    <div role="tablist" aria-label="Subscriber profile" className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((tab) => {
        const selected = tab === active;
        return (
          <button
            key={tab}
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              selected ? "border-accent font-semibold text-navy" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}
