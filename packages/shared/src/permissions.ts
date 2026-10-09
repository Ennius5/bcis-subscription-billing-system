export const PERMISSIONS = [
  "user.manage",
  "audit.view",
  "settings.manage",
  "backup.create",
  "backup.restore",
  "subscriber.view",
  "subscriber.manage",
  "plan.view",
  "plan.manage",
  "service.view",
  "service.manage",
  "billing.view",
  "billing.generate",
  "billing.void",
  "payment.view",
  "payment.create",
  "payment.reverse",
  "payment.allocate",
  "gcash.verify",
  "collection.view",
  "collection.manage",
  "collection.reconcile",
  "collection.close",
  "receivable.view",
  "suspension.manage",
  "report.view",
  "report.export",
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export const ROLE_DEFINITIONS = [
  { code: "owner", name: "Owner / Super Admin", description: "Full access" },
  { code: "administrator", name: "Administrator", description: "Operations, billing and collections" },
  { code: "cashier", name: "Cashier", description: "Receives payments and issues receipts" },
  { code: "collection_supervisor", name: "Collection Supervisor", description: "Routes, batches and remittance" },
  { code: "auditor", name: "Accounting / Auditor", description: "Reports, receivables and audit review" },
  { code: "technician", name: "Technician", description: "Service status and suspension work" },
  { code: "viewer", name: "Read-only Viewer", description: "Dashboards and reports only" },
] as const;

export type RoleCode = (typeof ROLE_DEFINITIONS)[number]["code"];

export const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionCode[]> = {
  owner: PERMISSIONS,
  administrator: [
    "audit.view", "subscriber.view", "subscriber.manage", "plan.view", "plan.manage",
    "service.view", "service.manage", "billing.view", "billing.generate", "billing.void",
    "payment.view", "payment.create", "payment.reverse", "payment.allocate", "gcash.verify",
    "collection.view", "collection.manage", "receivable.view", "suspension.manage", "report.view", "report.export",
  ],
  cashier: [
    "subscriber.view", "service.view", "billing.view", "payment.view",
    "payment.create", "gcash.verify", "receivable.view",
  ],
  collection_supervisor: [
    "subscriber.view", "billing.view", "payment.view", "collection.view",
    "collection.manage", "collection.reconcile", "collection.close",
    "receivable.view", "report.view",
  ],
  auditor: [
    "audit.view", "subscriber.view", "billing.view", "payment.view",
    "collection.view", "receivable.view", "report.view", "report.export",
  ],
  technician: ["service.view", "suspension.manage"],
  viewer: ["report.view", "receivable.view"],
};