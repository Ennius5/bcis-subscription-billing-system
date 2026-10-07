import type { PermissionCode } from "./permissions";

export interface NavItem {
  id: string;
  label: string;
  /** Leaf items: permission required to see it. Omit to show to any signed-in user. */
  permission?: PermissionCode;
  /** Groups have children and no permission of their own. */
  children?: readonly NavItem[];
}

// UI convenience only. The server enforces permissions on every request.
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "dashboard", label: "Dashboard", permission: "report.view" },
  {
    id: "subscribers",
    label: "Subscribers",
    children: [
      { id: "subscribers.all", label: "All Subscribers", permission: "subscriber.view" },
      { id: "subscribers.new", label: "New Subscriber", permission: "subscriber.manage" },
      { id: "subscribers.services", label: "Service Accounts", permission: "service.view" },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    children: [
      { id: "billing.current", label: "Current Billing", permission: "billing.view" },
      { id: "billing.generate", label: "Generate Billing", permission: "billing.generate" },
      { id: "billing.invoices", label: "Invoices", permission: "billing.view" },
    ],
  },
  {
    id: "payments",
    label: "Payments",
    children: [
      { id: "payments.receive", label: "Receive Payment", permission: "payment.create" },
      { id: "payments.history", label: "Payment History", permission: "payment.view" },
      { id: "payments.gcash", label: "GCash Verification", permission: "gcash.verify" },
    ],
  },
  {
    id: "collections",
    label: "Collections",
    children: [
      { id: "collections.collectors", label: "Collectors", permission: "collection.view" },
      { id: "collections.areas", label: "Areas & Routes", permission: "collection.view" },
      { id: "collections.batches", label: "Collection Batches", permission: "collection.view" },
      { id: "collections.remittance", label: "Remittance", permission: "collection.manage" },
    ],
  },
  {
    id: "receivables",
    label: "Receivables",
    children: [
      { id: "receivables.outstanding", label: "Outstanding", permission: "receivable.view" },
      { id: "receivables.overdue", label: "Overdue", permission: "receivable.view" },
      { id: "receivables.aging", label: "Aging", permission: "receivable.view" },
      { id: "receivables.suspension", label: "Suspension Candidates", permission: "suspension.manage" },
    ],
  },
  { id: "services", label: "Services", permission: "service.view" },
  { id: "reports", label: "Reports", permission: "report.view" },
  {
    id: "administration",
    label: "Administration",
    children: [
      { id: "admin.users", label: "Users", permission: "user.manage" },
      { id: "admin.audit", label: "Audit Log", permission: "audit.view" },
      { id: "admin.settings", label: "Settings", permission: "settings.manage" },
      { id: "admin.backup", label: "Backup & Restore", permission: "backup.create" },
    ],
  },
];

/** The navigation a user with these permissions should see. */
export function visibleNavigation(granted: readonly PermissionCode[]): NavItem[] {
  const has = new Set<PermissionCode>(granted);
  const walk = (items: readonly NavItem[]): NavItem[] =>
    items.flatMap((item) => {
      if (item.children) {
        const children = walk(item.children);
        return children.length > 0 ? [{ ...item, children }] : [];
      }
      return !item.permission || has.has(item.permission) ? [item] : [];
    });
  return walk(NAV_ITEMS);
}