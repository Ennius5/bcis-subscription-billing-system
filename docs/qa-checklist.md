# QA Checklist (spec section 14)

Final submission checklist, item by item, with the evidence for each. Automated evidence is
re-created with `pnpm --filter ./apps/api acceptance`, which writes
`tests/acceptance-test-report.md` and `.pdf`. Defects found along the way are in
[bug-log.md](bug-log.md).

Status: **Pass** = verified with the evidence shown. **On site** = ready, and confirmed during
setup on the laboratory PCs. **Step 10.x** = the deliverable is produced in that step.

| # | Checklist item | Status | Evidence |
|---|---|---|---|
| 1 | Application starts without development-only manual edits | Pass | The API runs from its production build (`apps/api/dist`) as a startup task; the desktop installer sets the server address on the sign-in page. [deployment-guide.md](deployment-guide.md) sections 3–4. |
| 2 | All three client PCs can connect to the API/database environment | On site | One API on the server PC, clients connect over the LAN (firewall rule for the local subnet, Private network profile). Three-session concurrency is tested automatically (AT-09) and by `pnpm --filter ./apps/api concurrency` against a running server. |
| 3 | No secrets or passwords are committed | Pass | History scanned 2026-10-11: the only environment file ever committed is `.env.example` (placeholders); `.env`, backups, proof images and logs are in `.gitignore`. Password-like strings in history are fake values inside tests. Passwords are stored as argon2id hashes. |
| 4 | Database migrations run from a clean database | Pass | 27 migrations applied to an empty database (schemas dropped) followed by all seeds, 2026-10-11; every test run also migrates `bcis_test`. |
| 5 | Seed/demo data is synthetic | Pass | [database/seeds/README.md](../database/seeds/README.md): invented names, `0999 000 xxxx` numbers, `example.com` emails, a drawn GCash screenshot. |
| 6 | RBAC and server-side permission checks are demonstrated | Pass | AT-10; `security/route-guards.test.ts` calls every one of the API's routes without a token (401) and without the permission (403). |
| 7 | Monthly billing does not create duplicates | Pass | AT-11 (re-running generate and finalize changes nothing); unique index `invoices_one_per_period_idx`. |
| 8 | Partial, exact and advance payment cases are correct | Pass | AT-01, AT-02, AT-03, AT-04 with the spec's amounts. |
| 9 | Payment reversal preserves history and audit trail | Pass | AT-06: the original receipt stays, the reversal is linked, balances restore, actor and reason are audited. Payments, allocations, reversals and ledger entries are append-only (database triggers). |
| 10 | Receipt numbers are unique and voided numbers are not reused | Pass | AT-09 (15 parallel receipts, no repeats or gaps); `payments/service.test.ts` "never share or skip a receipt number"; `billing/service.test.ts` "the number stays" on a voided invoice; integrity check "counters". |
| 11 | Collector shortage/overage is visible and not silently balanced | Pass | AT-08: reconciling as balanced and closing as ₱0 are both refused; the shortage needs a reason and stays on the batch. |
| 12 | AR aging totals reconcile to outstanding invoice balances | Pass | `acceptance/reconciliation.test.ts` on the full demo dataset: aging total = open invoice balances; minus unapplied credit = the sum of all ledgers; Outstanding/Overdue lists and the dashboard match; all 50 Statements of Account reconcile. |
| 13 | PDF/XLSX reports calculate correctly | Pass | `acceptance/reconciliation.test.ts`: Collections and Billing vs Collection equal the payments and invoices underneath; the exported XLSX totals equal the report; PDFs are produced. Sample files: `reports-samples/` (step 10.5). |
| 14 | Backup and restore were tested | Pass | AT-12 (back up, change, restore, integrity passes, records return); `backup/restore.test.ts`; the app's Test restore button restores into a scratch database. |
| 15 | Unit/integration/E2E or equivalent acceptance evidence is included | Pass | `tests/acceptance-test-report.pdf`: AT-01..AT-12, reconciliation checks, and totals for all automated tests. Desktop screenshots: `tests/screenshots/` (step 10.5). |
| 16 | Technical documentation, user manual and deployment guide are included | Step 10.4 / 10.5 | Deployment guide done; technical documentation (step 10.4) and user manual (step 10.5). |
| 17 | Final release/installer and README are included | Step 10.6 | Installer builds today (`pnpm --filter @bcis/desktop dist`); README and the GitHub release in step 10.6. |
| 18 | The implementation and design decisions can be explained during the defense | Step 10.6 | Defense notes and answers to the spec's defense questions (step 10.6). |
