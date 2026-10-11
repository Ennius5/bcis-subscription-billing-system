# Acceptance Test Report

BCIS Subscription Billing and Collection System: mandatory acceptance tests (spec section 7) and automated test evidence (spec 7.1, deliverable D5).

| | |
|---|---|
| Generated | October 11, 2026 at 3:27 PM (Asia/Manila) |
| Source | commit `3b61f91` |
| Environment | Node v24.15.0, PostgreSQL 18.6, Windows_NT 10.0.19045 |
| Billing months used | 2026-08 (the spec's "August"), 2026-09 ("September"), 2026-10 |
| Overall result | <span class="pass">PASS</span> all tests passed |

## How these tests run

The acceptance suite (`apps/api/src/acceptance/acceptance.test.ts`) uses the spec's own test data and drives the system through its HTTP API, exactly as the desktop app does: each user signs in and sends requests with their session token, and the server checks permissions on every request. Plans, subscribers and installations are set up directly; every step being tested (billing, payments, GCash, reversals, collector batches, backups) goes over HTTP. The tests run against a dedicated test database (`bcis_test`).

To reproduce: `pnpm --filter ./apps/api acceptance` (this report), or `pnpm --filter ./apps/api test` (all API tests).

## Summary

| ID | Scenario | Test data | Expected result | Result | Time |
|---|---|---|---|---|---|
| AT-01 | Exact payment | Invoice ₱999; payment ₱999 | Remaining ₱0; invoice PAID; ledger balanced; receipt created. | <span class="pass">PASS</span> | 76 ms |
| AT-02 | Partial payment | Invoice ₱999; payment ₱500 | Remaining ₱499; PARTIALLY_PAID; allocation and ledger correct. | <span class="pass">PASS</span> | 40 ms |
| AT-03 | Advance payment | Monthly ₱1,000; payment ₱3,000 | Allocation/credit follows documented policy without losing value. | <span class="pass">PASS</span> | 140 ms |
| AT-04 | Oldest-first arrears | August 2026 ₱999 + September 2026 ₱999; payment ₱1,200 | August ₱0; September ₱798 remaining. | <span class="pass">PASS</span> | 43 ms |
| AT-05 | Duplicate GCash reference | GCash reference 970336503705, verified once (with proof image), then submitted again | System blocks or explicitly warns according to documented verification policy. | <span class="pass">PASS</span> | 88 ms |
| AT-06 | Payment reversal | Reverse an incorrectly posted ₱999 cash payment | Original remains visible; linked reversal exists; balances restore; actor/reason audited. | <span class="pass">PASS</span> | 245 ms |
| AT-07 | Collector balanced remittance | Cash collected ₱20,000; remitted ₱20,000 | Difference ₱0; batch may reconcile/close. | <span class="pass">PASS</span> | 169 ms |
| AT-08 | Collector shortage | Cash collected ₱20,000; remitted ₱19,500 | ₱500 shortage displayed; cannot silently close as balanced. | <span class="pass">PASS</span> | 168 ms |
| AT-09 | Concurrent users | Three signed-in sessions (two cashiers, one administrator) each post 5 payments of ₱100 and read the payment list, all at the same time | No data corruption, duplicate numbering or unauthorized cross-session effect. | <span class="pass">PASS</span> | 985 ms |
| AT-10 | Authorization | Cashier calls admin-only user and backup endpoints directly (no UI) | Server rejects operation even if API is called directly. | <span class="pass">PASS</span> | 23 ms |
| AT-11 | Duplicate billing | Run billing generation and finalization for September 2026 twice more | No duplicate finalized invoice for same service account/period. | <span class="pass">PASS</span> | 108 ms |
| AT-12 | Backup/restore | Create a backup, post a ₱100 payment, restore the backup | Restored database passes integrity check and expected records return. | <span class="pass">PASS</span> | 4712 ms |

## Results in detail

### AT-01 Exact payment <span class="pass">PASS</span>

**Test data:** Invoice ₱999; payment ₱999

**Expected (spec):** Remaining ₱0; invoice PAID; ledger balanced; receipt created.

**Observed:**

- Invoice INV-000116: total ₱999.00, paid ₱999.00, remaining ₱0.00, status paid.
- Ledger: debits ₱999.00 = credits ₱999.00; balance ₱0.00.
- Receipt RCPT-000123 issued (cash, ₱999.00), all of it applied to INV-000116.

Automated test: `AT-01 Exact payment: ₱999 on a ₱999 invoice leaves ₱0, PAID, ledger balanced, receipt created`

Also covered by: `apps/api/src/payments/service.test.ts`, `packages/shared/src/allocation.test.ts`

### AT-02 Partial payment <span class="pass">PASS</span>

**Test data:** Invoice ₱999; payment ₱500

**Expected (spec):** Remaining ₱499; PARTIALLY_PAID; allocation and ledger correct.

**Observed:**

- Invoice INV-000117: paid ₱500.00, remaining ₱499.00, stored status partially_paid (shown as "overdue" because the due date has passed).
- Allocation: ₱500.00 of receipt RCPT-000124 to INV-000117.
- Ledger balance ₱499.00 (debits ₱999.00, credits ₱500.00).

Automated test: `AT-02 Partial payment: ₱500 on ₱999 leaves ₱499, PARTIALLY_PAID, allocation and ledger correct`

Also covered by: `apps/api/src/payments/service.test.ts`, `packages/shared/src/allocation.test.ts`

### AT-03 Advance payment <span class="pass">PASS</span>

**Test data:** Monthly ₱1,000; payment ₱3,000

**Expected (spec):** Allocation/credit follows documented policy without losing value.

**Observed:**

- Policy: a payment pays open bills oldest-first; the rest is kept as credit and applied oldest-first when the next month is finalized.
- On posting: ₱1,000.00 to INV-000118 (September 2026), ₱2,000.00 kept as credit; ledger -₱2,000.00 (in the subscriber's favour).
- After billing October 2026: INV-000131 paid from credit; receipt RCPT-000125 now ₱2,000.00 applied + ₱1,000.00 credit = ₱3,000.00. Ledger -₱1,000.00.

Automated test: `AT-03 Advance payment: ₱3,000 on a ₱1,000 plan becomes credit used by later bills, nothing lost`

Also covered by: `apps/api/src/payments/service.test.ts`, `packages/shared/src/allocation.test.ts`

### AT-04 Oldest-first arrears <span class="pass">PASS</span>

**Test data:** August 2026 ₱999 + September 2026 ₱999; payment ₱1,200

**Expected (spec):** August ₱0; September ₱798 remaining.

**Observed:**

- INV-000115 (August 2026): ₱999.00 applied, remaining ₱0.00, paid.
- INV-000119 (September 2026): ₱201.00 applied, remaining ₱798.00, partially_paid.

Automated test: `AT-04 Oldest-first arrears: ₱1,200 on two ₱999 bills clears the older, leaves ₱798 on the newer`

Also covered by: `apps/api/src/payments/service.test.ts`, `packages/shared/src/allocation.test.ts`

### AT-05 Duplicate GCash reference <span class="pass">PASS</span>

**Test data:** GCash reference 970336503705, verified once (with proof image), then submitted again

**Expected (spec):** System blocks or explicitly warns according to documented verification policy.

**Observed:**

- Policy: a GCash reference can be used once; the server refuses a second submission (unique index on the normalized reference).
- First submission verified: payment posted for ₱999.00.
- Second submission: HTTP 409 DUPLICATE_REFERENCE: "GCash reference 970336503705 is already used by receipt RCPT-000127 (account BCIS-000834)."
- Payments for the subscriber: 1 before and 1 after the attempt.

Automated test: `AT-05 Duplicate GCash reference: a verified reference cannot be used again`

Also covered by: `apps/api/src/payments/gcash.test.ts`, `apps/api/src/payments/routes.test.ts`, `apps/api/src/payments/schema.test.ts`

### AT-06 Payment reversal <span class="pass">PASS</span>

**Test data:** Reverse an incorrectly posted ₱999 cash payment

**Expected (spec):** Original remains visible; linked reversal exists; balances restore; actor/reason audited.

**Observed:**

- Receipt RCPT-000128 is still on file with status reversed; reversal by Test administrator: "Posted to the wrong subscriber".
- Invoice INV-000121 back to ₱999.00 owing (unpaid).
- Ledger balance ₱1,998.00 before, ₱1,998.00 after; two entries added (payment credit and reversal debit), none removed.
- Audit: payment.reverse by Test administrator, reason "Posted to the wrong subscriber".

Automated test: `AT-06 Payment reversal: original stays visible, reversal linked, balance restored, actor and reason audited`

Also covered by: `apps/api/src/payments/service.test.ts`

### AT-07 Collector balanced remittance <span class="pass">PASS</span>

**Test data:** Cash collected ₱20,000; remitted ₱20,000

**Expected (spec):** Difference ₱0; batch may reconcile/close.

**Observed:**

- Batch CB-000009: cash collected ₱20,000.00 (two field collections of ₱10,000), remitted ₱20,000.00.
- Reconciled: difference ₱0.00, balanced. Closed: status closed.

Automated test: `AT-07 Collector balanced remittance: ₱20,000 collected and remitted, difference ₱0, batch closes`

Also covered by: `apps/api/src/collection/reconciliation.test.ts`, `apps/api/src/collection/batch-routes.test.ts`, `packages/shared/src/collection-batches.test.ts`

### AT-08 Collector shortage <span class="pass">PASS</span>

**Test data:** Cash collected ₱20,000; remitted ₱19,500

**Expected (spec):** ₱500 shortage displayed; cannot silently close as balanced.

**Observed:**

- Batch CB-000010: collected ₱20,000.00, remitted ₱19,500.00.
- Reconcile as balanced: HTTP 409 "The figures changed: the difference is now ₱500.00 shortage. Review the batch and confirm again."
- Reconcile without a reason: HTTP 400 (Explain the shortage or overage.)
- Reconciled with reason: difference -₱500.00, shortage.
- Close confirming ₱0: HTTP 409 "This batch was reconciled with a difference of ₱500.00 shortage. Confirm that figure to close it.". Close confirming the shortage: closed, shortage kept on the batch.

Automated test: `AT-08 Collector shortage: ₱20,000 collected, ₱19,500 remitted shows ₱500 short and cannot close as balanced`

Also covered by: `apps/api/src/collection/reconciliation.test.ts`, `apps/api/src/collection/batch-routes.test.ts`, `packages/shared/src/collection-batches.test.ts`

### AT-09 Concurrent users <span class="pass">PASS</span>

**Test data:** Three signed-in sessions (two cashiers, one administrator) each post 5 payments of ₱100 and read the payment list, all at the same time

**Expected (spec):** No data corruption, duplicate numbering or unauthorized cross-session effect.

**Observed:**

- 30 requests in parallel, all HTTP 200. 15 receipts RCPT-000133 to RCPT-000147: no repeats, no gaps.
- Each subscriber's balance went down by exactly ₱500.00 (₱1,998.00, ₱1,998.00, ₱1,998.00 → ₱1,498.00, ₱1,498.00, ₱1,498.00).
- Each receipt names the user of the session that posted it.
- After one cashier signed out: that token gets 401; the other two sessions still get 200.
- Larger runs: apps/api/src/concurrency/at09.test.ts (billing, 30 payments, field collections, adjustments in parallel) and the three-PC script `pnpm --filter ./apps/api concurrency`.

Automated test: `AT-09 Concurrent users: three sessions posting and reading at once keep numbers and balances right`

Also covered by: `apps/api/src/concurrency/at09.test.ts`, `apps/api/src/concurrency/three-clients.ts (manual, 3 PCs)`

### AT-10 Authorization <span class="pass">PASS</span>

**Test data:** Cashier calls admin-only user and backup endpoints directly (no UI)

**Expected (spec):** Server rejects operation even if API is called directly.

**Observed:**

- POST /admin/users as cashier: HTTP 403 FORBIDDEN.
- GET /admin/users as cashier: HTTP 403 FORBIDDEN.
- POST /backups as cashier: HTTP 403 FORBIDDEN.
- GET /backups as cashier: HTTP 403 FORBIDDEN.
- POST /backups without a token: HTTP 401.
- Users 5 → 5, backups 0 → 0: nothing was created.
- Every route is covered the same way by apps/api/src/security/route-guards.test.ts (401 without a token, 403 without the permission).

Automated test: `AT-10 Authorization: a cashier calling user and backup operations directly is refused by the server`

Also covered by: `apps/api/src/security/route-guards.test.ts`, `apps/api/src/admin/users.test.ts`, `apps/api/src/backup/routes.test.ts`, `apps/api/src/auth/authorization.test.ts`

### AT-11 Duplicate billing <span class="pass">PASS</span>

**Test data:** Run billing generation and finalization for September 2026 twice more

**Expected (spec):** No duplicate finalized invoice for same service account/period.

**Observed:**

- Live invoices for September 2026: 13 before, 13 after two more runs.
- Run 1: generate created 0 drafts; finalize answered HTTP 409 NOTHING_TO_FINALIZE (nothing new to number).
- Run 2: generate created 0 drafts; finalize answered HTTP 409 NOTHING_TO_FINALIZE (nothing new to number).
- No service account has two live invoices for any month.
- Database guard: CREATE UNIQUE INDEX invoices_one_per_period_idx ON public.invoices (service_account_id, period_start) WHERE (status <> 'void'::text).

Automated test: `AT-11 Duplicate billing: generating and finalizing the same month twice creates no second invoice`

Also covered by: `apps/api/src/billing/service.test.ts`, `apps/api/src/billing/schema.test.ts`

### AT-12 Backup/restore <span class="pass">PASS</span>

**Test data:** Create a backup, post a ₱100 payment, restore the backup

**Expected (spec):** Restored database passes integrity check and expected records return.

**Observed:**

- Backup BK-000079 created and verified (checksums + pg_restore --list).
- Payments: 25 at backup, 26 after the change, 25 after restoring; receipt RCPT-000148 (made after the backup) is gone.
- A safety backup BK-000080 was taken before restoring.
- Integrity check after restore: migrations passed, invoice_paid passed, payment_allocated passed, ledger_balance passed, counters passed, proof_files passed, row_counts passed.
- All sessions were signed out by the restore (old token: HTTP 401).

Automated test: `AT-12 Backup/restore: back up, change data, restore; integrity passes and the records return`

Also covered by: `apps/api/src/backup/restore.test.ts`

## All automated tests

Unit tests for the domain and money rules (`packages/shared`), and integration tests for every API service and route against PostgreSQL (`apps/api`), including the acceptance suite above.

| Package | Test files | Tests | Passed | Failed |
|---|---|---|---|---|
| @bcis/shared (domain rules, money, allocation, validation) | 17 | 209 | 209 | 0 |
| @bcis/api (services, routes, security, backup, concurrency) | 48 | 551 | 551 | 0 |

## Manual and desktop evidence

Desktop workflows are checked by hand against the same rules; screenshots are in `tests/screenshots/`, sample report files in `reports-samples/`, and defects found with their fixes in `docs/bug-log.md`.
