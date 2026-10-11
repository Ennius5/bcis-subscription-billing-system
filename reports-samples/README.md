# Report samples (D6)

Exported on 2026-10-11 from the synthetic demo dataset (`database/seeds/README.md`) with the app's own Export buttons' endpoints, signed in as `demo_admin`. Regenerate with `pnpm --filter ./apps/api report-samples`.

Every report is available as PDF (to print or send) and XLSX (to analyse); both are built from the same report data, so they show the same figures. The totals are checked against the underlying invoices and payments by `apps/api/src/acceptance/reconciliation.test.ts`.

| Files | Report | What it shows |
|---|---|---|
| `01-collections-2026-09.pdf`, `.xlsx` | Monthly collection report, September 2026 | Collections per day and per payment method, reversals, net collected. |
| `02-ar-aging.pdf`, `.xlsx` | AR aging as of 2026-10-11 | Open balances in current, 1-30, 31-60, 61-90 and 90+ day buckets; unapplied credit; net receivable. |
| `03-statement-of-account-BCIS-000017.pdf`, `.xlsx` | Statement of Account, BCIS-000017 | The subscriber's ledger, open invoices, aging and balance. |
| `04-collector-performance-2026-07-to-2026-10.pdf`, `.xlsx` | Collector remittance and performance, July 2026 to today | Per collector: batches, expected, collected, remitted, shortages and overages, collection rate. |
| `05-billing-vs-collection-2026-07-to-2026-10.pdf`, `.xlsx` | Billing vs collection, July 2026 to October 2026 | Billed, adjustments, net billed, collected, collection rate and gap per month. |
| `06-revenue-by-plan-2026-07-to-2026-10.pdf`, `.xlsx` | Revenue by plan, July 2026 to October 2026 | Net billed per plan and month. |
| `07-subscriber-master-list.pdf`, `.xlsx` | Subscriber master list | Every subscriber with status, area, collector, services and balance. |
| `08-exceptions-2026-07-to-2026-10.pdf`, `.xlsx` | Exceptions register (adjustments, reversals, voids) | Every adjustment, payment reversal and invoice void with who and why. |
| `09-user-activity-2026-10.pdf`, `.xlsx` | User activity | Actions per user from the audit trail. |

Printed receipts and collection route sheets are printed from the desktop app; see `tests/screenshots/`.
