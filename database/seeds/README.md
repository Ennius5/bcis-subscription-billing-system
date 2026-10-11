# Seed data

The seed scripts live with the API code, because they go through the same services as the
app. Every seeded record is created by a real service call, so it gets its audit rows,
document numbers and ledger entries exactly as if a clerk had entered it.

| Command (from the repo root) | What it does | Safe to run again |
|---|---|---|
| `pnpm --filter ./apps/api db:seed` | Roles, permissions and the owner account (from `.env`) | Yes |
| `pnpm --filter ./apps/api db:seed-demo` | Demo users, one per role, password from `SEED_DEMO_PASSWORD` | Yes |
| `pnpm --filter ./apps/api db:seed-data` | The demo dataset below (needs the demo users) | Yes, it skips if already seeded |
| `pnpm --filter ./apps/api db:seed-all` | All three, in that order | Yes |

Sources: `apps/api/src/db/seed-rbac.ts`, `seed-demo-users.ts`, `seed-demo-data.ts` and
`seed-demo-activity.ts`.

All data is synthetic. Names are made up, phone numbers are in the unused `0999 000 xxxx`
range, emails use `example.com`, and the GCash screenshot is a drawing
(`tests/fixtures/sample-proof.png`).

## The demo dataset (spec section 8)

| Spec minimum | Seeded |
|---|---|
| 5 users: Admin, Cashier, Collection Supervisor, Auditor/Viewer | 7: owner, `demo_admin`, `demo_cashier`, `demo_supervisor`, `demo_auditor`, `demo_technician`, `demo_viewer` |
| 3 Internet, 2 Cable, 2 Combo plans | 3 Internet, 2 Cable, 2 Combo |
| 50 subscribers | 50 |
| 60+ service accounts across Internet/Cable/Combo | 63: active, pending installation, suspended and terminated |
| 2 collectors, 3 areas | 2 collectors (COL-01 walks North and Central, COL-02 walks South), 3 areas |
| Invoices for at least 3 billing months | 4 months: the current one and the three before it (about 226 invoices) |
| Cash, GCash, partial, exact and advance payments | Cash, GCash (with proof), bank transfer, cheque, field collections; exact, partial (P500 a month), advance (3 months up front) and one-month-late payers |
| 10+ overdue accounts in several aging buckets | About 17, spread over 1-30, 31-60, 61-90 and 90+ days |
| 1 reversal / void | A payment keyed with an extra zero, reversed and re-posted; an invoice voided at disconnection; an outage rebate |
| 2 suspension / reconnection scenarios | 3 suspensions for non-payment; 2 paid up and reconnected (one fee waived), 1 still suspended |

Collector batches: last two months' batches are closed (one with a P500 shortage, explained),
and this month's two batches are still "in the field" so the live demo can submit, remit and
reconcile one. One GCash payment from the last few days is left waiting for verification, so
the demo can verify it and then try the same reference again (AT-05).

### How it is built

`seed-demo-data.ts` creates the plans, areas, collectors, subscribers and services and
installs them on their (past) installation dates. `seed-demo-activity.ts` then replays the
last four months day by day: billing on the 1st, each subscriber paying around their due
date according to how they pay, services terminated, suspended and reconnected on the day,
and collectors going out with batches. Receipt numbers therefore follow the payment dates.

Business dates (installation, billing, due, payment, collection and reconnection dates) are
back-dated; record timestamps (such as "Customer since" or "entered at") are the moment the seed
ran, because the system always stamps when a record was actually written.

The random choices come from a fixed seed, so every run produces the same people and the
same payment pattern. The months are counted back from today, so **seed shortly before a
demo**: a dataset seeded weeks earlier has no bill for the new month and older aging.

At the end the script prints a summary. Running the integrity check in the app
(Administration > Backup & Restore > Run integrity check) right after seeding should pass.

## Seeding a fresh demo database

`db:seed-data` refuses to run on a database that already has invoices or payments, because
the months it replays must be the only billing history. Use a fresh database.

Option A, a separate demo database (keeps your current data). In psql as `postgres`:

```sql
CREATE DATABASE bcis_demo OWNER bcis_app;
```

Then point `DATABASE_URL` in `apps/api/.env` at `bcis_demo` and run, from the repo root:

```powershell
pnpm --filter ./apps/api db:migrate
pnpm --filter ./apps/api db:seed-all
```

Switch `DATABASE_URL` back to `bcis` afterwards if you want your old data.

Option B, start `bcis` over. **This deletes everything in it**, so take a backup first if
anything there matters. Stop the API, then in psql as `postgres`:

```sql
DROP DATABASE bcis;
CREATE DATABASE bcis OWNER bcis_app;
```

Then run the same two commands as in option A. Proof images from the old database stay in
the proof folder; they are harmless and can be deleted.
