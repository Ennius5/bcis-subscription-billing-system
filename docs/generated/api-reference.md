# API Reference

Generated from the running route table: 121 routes. Every route except the public ones requires a session token (`Authorization: Bearer …`); the permissions listed are checked on the server on every request, against the database. Bodies, queries and path parameters are validated with the Zod schemas in `@bcis/shared`; errors are JSON `{ error, message }`, validation errors `{ error: "VALIDATION", issues }`.

## /admin

| Method | Path | Access |
|---|---|---|
| GET | `/admin/users` | `user.manage` |
| POST | `/admin/users` | `user.manage` |
| PATCH | `/admin/users/:id` | `user.manage` |
| POST | `/admin/users/:id/reset-password` | `user.manage` |
| POST | `/admin/users/:id/roles` | `user.manage` |
| POST | `/admin/users/:id/status` | `user.manage` |
| POST | `/admin/users/:id/unlock` | `user.manage` |

## /audit-logs

| Method | Path | Access |
|---|---|---|
| GET | `/audit-logs` | `audit.view` |
| GET | `/audit-logs/filter-options` | `audit.view` |

## /auth

| Method | Path | Access |
|---|---|---|
| POST | `/auth/login` | Public |
| POST | `/auth/logout` | Signed in (own account) |
| GET | `/auth/me` | Signed in (own account) |
| POST | `/auth/password` | Signed in (own account) |

## /backups

| Method | Path | Access |
|---|---|---|
| GET | `/backups` | `backup.create` |
| POST | `/backups` | `backup.create` |
| POST | `/backups/:id/restore` | `backup.restore` |
| POST | `/backups/:id/test-restore` | `backup.create` |
| POST | `/backups/:id/verify` | `backup.create` |

## /billing

| Method | Path | Access |
|---|---|---|
| POST | `/billing/discard-drafts` | `billing.generate` |
| POST | `/billing/finalize` | `billing.generate` |
| POST | `/billing/generate` | `billing.generate` |
| GET | `/billing/summary` | `billing.view` |

## /collection-areas

| Method | Path | Access |
|---|---|---|
| GET | `/collection-areas` | `collection.view` |
| POST | `/collection-areas` | `collection.manage` |
| PATCH | `/collection-areas/:id` | `collection.manage` |

## /collection-batches

| Method | Path | Access |
|---|---|---|
| GET | `/collection-batches` | `collection.view` |
| POST | `/collection-batches` | `collection.manage` |
| GET | `/collection-batches/:id` | `collection.view` |
| POST | `/collection-batches/:id/accounts` | `collection.manage` |
| DELETE | `/collection-batches/:id/accounts/:subscriberId` | `collection.manage` |
| POST | `/collection-batches/:id/cancel` | `collection.manage` |
| POST | `/collection-batches/:id/close` | `collection.close` |
| POST | `/collection-batches/:id/collections` | `collection.manage` |
| POST | `/collection-batches/:id/dispatch` | `collection.manage` |
| POST | `/collection-batches/:id/reconcile` | `collection.reconcile` |
| POST | `/collection-batches/:id/remittances` | `collection.manage` |
| POST | `/collection-batches/:id/remittances/:remittanceId/void` | `collection.manage` |
| POST | `/collection-batches/:id/submit` | `collection.manage` |

## /collection-reports

| Method | Path | Access |
|---|---|---|
| GET | `/collection-reports/collectors` | `collection.view` |
| GET | `/collection-reports/collectors/export` | `collection.view` + `report.export` |

## /collectors

| Method | Path | Access |
|---|---|---|
| GET | `/collectors` | `collection.view` |
| POST | `/collectors` | `collection.manage` |
| PATCH | `/collectors/:id` | `collection.manage` |
| GET | `/collectors/available-users` | `collection.manage` |

## /dashboard

| Method | Path | Access |
|---|---|---|
| GET | `/dashboard` | `report.view` |

## /gcash-proofs

| Method | Path | Access |
|---|---|---|
| GET | `/gcash-proofs/:id` | `payment.view` |

## /gcash-submissions

| Method | Path | Access |
|---|---|---|
| GET | `/gcash-submissions` | `payment.view` |
| POST | `/gcash-submissions` | `payment.create` |
| GET | `/gcash-submissions/:id` | `payment.view` |
| POST | `/gcash-submissions/:id/proofs` | `payment.create` |
| POST | `/gcash-submissions/:id/reject` | `gcash.verify` |
| POST | `/gcash-submissions/:id/verify` | `gcash.verify` |

## /health

| Method | Path | Access |
|---|---|---|
| GET | `/health` | Public |
| GET | `/health/db` | Public |

## /integrity-checks

| Method | Path | Access |
|---|---|---|
| GET | `/integrity-checks` | `backup.create` |
| POST | `/integrity-checks` | `backup.create` |

## /invoices

| Method | Path | Access |
|---|---|---|
| GET | `/invoices` | `billing.view` |
| GET | `/invoices/:id` | `billing.view` |
| POST | `/invoices/:id/adjustments` | `billing.adjust` |
| POST | `/invoices/:id/void` | `billing.void` |

## /payments

| Method | Path | Access |
|---|---|---|
| GET | `/payments` | `payment.view` |
| POST | `/payments` | `payment.create` |
| GET | `/payments/:id` | `payment.view` |
| POST | `/payments/:id/reverse` | `payment.reverse` |

## /plans

| Method | Path | Access |
|---|---|---|
| GET | `/plans` | `plan.view` |
| POST | `/plans` | `plan.manage` |
| PATCH | `/plans/:id` | `plan.manage` |

## /receivables

| Method | Path | Access |
|---|---|---|
| GET | `/receivables` | `receivable.view` |
| GET | `/receivables/aging` | `receivable.view` |
| GET | `/receivables/aging/export` | `receivable.view` + `report.export` |
| GET | `/receivables/filter-options` | any of `receivable.view`, `suspension.manage` |
| GET | `/receivables/suspension-candidates` | `suspension.manage` |

## /reconnections

| Method | Path | Access |
|---|---|---|
| GET | `/reconnections` | `suspension.manage` |
| GET | `/reconnections/:id` | `suspension.manage` |
| POST | `/reconnections/:id/assign` | `suspension.manage` |
| POST | `/reconnections/:id/cancel` | `suspension.manage` |
| POST | `/reconnections/:id/complete` | `suspension.manage` |

## /reports

| Method | Path | Access |
|---|---|---|
| GET | `/reports/billing-vs-collection` | `report.view` |
| GET | `/reports/billing-vs-collection/export` | `report.view` + `report.export` |
| GET | `/reports/collections` | `report.view` |
| GET | `/reports/collections/export` | `report.view` + `report.export` |
| GET | `/reports/exceptions` | `report.view` |
| GET | `/reports/exceptions/export` | `report.view` + `report.export` |
| GET | `/reports/revenue` | `report.view` |
| GET | `/reports/revenue/export` | `report.view` + `report.export` |
| GET | `/reports/subscribers` | `report.view` |
| GET | `/reports/subscribers/export` | `report.view` + `report.export` |
| GET | `/reports/user-activity` | `audit.view` |
| GET | `/reports/user-activity/export` | `audit.view` + `report.export` |

## /search

| Method | Path | Access |
|---|---|---|
| GET | `/search` | `subscriber.view` |

## /service-accounts

| Method | Path | Access |
|---|---|---|
| GET | `/service-accounts` | `service.view` |
| GET | `/service-accounts/:id` | `service.view` |
| PATCH | `/service-accounts/:id` | `service.manage` |
| POST | `/service-accounts/:id/collector` | `service.manage` |
| POST | `/service-accounts/:id/plan` | `service.manage` |
| POST | `/service-accounts/:id/rate` | `service.manage` |
| POST | `/service-accounts/:id/reconnections` | `suspension.manage` |
| GET | `/service-accounts/:id/service-control` | `service.view` |
| POST | `/service-accounts/:id/status` | `service.manage` |
| POST | `/service-accounts/:id/suspend` | `suspension.manage` |

## /settings

| Method | Path | Access |
|---|---|---|
| GET | `/settings/receivables` | `settings.manage` |
| PATCH | `/settings/receivables` | `settings.manage` |

## /subscribers

| Method | Path | Access |
|---|---|---|
| GET | `/subscribers` | `subscriber.view` |
| POST | `/subscribers` | `subscriber.manage` |
| GET | `/subscribers/:id` | `subscriber.view` |
| PATCH | `/subscribers/:id` | `subscriber.manage` |
| POST | `/subscribers/:id/addresses` | `subscriber.manage` |
| PATCH | `/subscribers/:id/addresses/:addressId` | `subscriber.manage` |
| POST | `/subscribers/:id/assignment` | `subscriber.manage` |
| GET | `/subscribers/:id/audit` | `subscriber.view` + `audit.view` |
| GET | `/subscribers/:id/collections` | `subscriber.view` + `collection.view` |
| POST | `/subscribers/:id/contacts` | `subscriber.manage` |
| PATCH | `/subscribers/:id/contacts/:contactId` | `subscriber.manage` |
| GET | `/subscribers/:id/history` | `subscriber.view` |
| GET | `/subscribers/:id/ledger` | `billing.view` |
| GET | `/subscribers/:id/payment-context` | `payment.view` |
| POST | `/subscribers/:id/service-accounts` | `service.manage` |
| GET | `/subscribers/:id/statement` | `billing.view` |
| GET | `/subscribers/:id/statement/export` | `billing.view` |
| POST | `/subscribers/:id/status` | `subscriber.manage` |

## /technicians

| Method | Path | Access |
|---|---|---|
| GET | `/technicians` | `suspension.manage` |

## Roles and permissions

Which permissions each role grants (seeded by `db:seed`, `apps/api/src/db/rbac.ts`).

| Permission | Owner / Super Admin | Administrator | Cashier | Collection Supervisor | Accounting / Auditor | Technician | Read-only Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `user.manage` | ✓ |  |  |  |  |  |  |
| `audit.view` | ✓ | ✓ |  |  | ✓ |  |  |
| `settings.manage` | ✓ |  |  |  |  |  |  |
| `backup.create` | ✓ |  |  |  |  |  |  |
| `backup.restore` | ✓ |  |  |  |  |  |  |
| `subscriber.view` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `subscriber.manage` | ✓ | ✓ |  |  |  |  |  |
| `plan.view` | ✓ | ✓ |  |  |  |  |  |
| `plan.manage` | ✓ | ✓ |  |  |  |  |  |
| `service.view` | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `service.manage` | ✓ | ✓ |  |  |  |  |  |
| `billing.view` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `billing.generate` | ✓ | ✓ |  |  |  |  |  |
| `billing.void` | ✓ | ✓ |  |  |  |  |  |
| `billing.adjust` | ✓ | ✓ |  |  |  |  |  |
| `payment.view` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `payment.create` | ✓ | ✓ | ✓ |  |  |  |  |
| `payment.reverse` | ✓ | ✓ |  |  |  |  |  |
| `payment.allocate` | ✓ | ✓ |  |  |  |  |  |
| `gcash.verify` | ✓ | ✓ | ✓ |  |  |  |  |
| `collection.view` | ✓ | ✓ |  | ✓ | ✓ |  |  |
| `collection.manage` | ✓ | ✓ |  | ✓ |  |  |  |
| `collection.reconcile` | ✓ |  |  | ✓ |  |  |  |
| `collection.close` | ✓ |  |  | ✓ |  |  |  |
| `receivable.view` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `suspension.manage` | ✓ | ✓ |  |  |  | ✓ |  |
| `report.view` | ✓ | ✓ |  | ✓ | ✓ |  | ✓ |
| `report.export` | ✓ | ✓ |  | ✓ | ✓ |  |  |
