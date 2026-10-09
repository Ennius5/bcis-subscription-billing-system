# BCIS Subscription Billing and Collection System

Desktop billing and collection system for Bukidnon Cable and Internet
Services (lab project). Three office PCs run the Electron client; all
data access goes through the Fastify API to PostgreSQL. Not just CRUD:
financial history, correct balances and audit trails matter more than
visual polish.

## Stack (fixed by the spec, do not propose alternatives)

Node 24, pnpm 11 monorepo, strict TypeScript, PostgreSQL 18, Fastify 5,
Drizzle ORM + drizzle-kit, Zod 4, Vitest 5, pino, argon2id
(@node-rs/argon2), Electron 44 + electron-vite, React 19, Tailwind CSS 4.

## Layout

- `apps/api/src/{auth,admin,audit,plans,collection,subscribers,http,db,test}`
- `apps/desktop` (`src/main`, `src/preload`, `src/renderer/src/...`)
- `packages/shared` (`@bcis/shared`): Zod schemas, domain rules, money
  helpers, navigation tree and permission codes, shared by API and desktop
- `database/{migrations,seeds}`

## Commands (run from the repo root, PowerShell-safe)

- Typecheck: `pnpm --filter @bcis/api typecheck` (also `@bcis/shared`,
  `@bcis/desktop`)
- Tests: `pnpm --filter @bcis/api test` and
  `pnpm --filter @bcis/shared test`. Vitest does not typecheck, so run
  both typecheck and tests before calling anything done.
- Migrations: `pnpm --filter ./apps/api db:generate`, then
  `pnpm --filter ./apps/api db:migrate`. Tests migrate `bcis_test`
  automatically through `prepareTestDatabase`.
- Config lives in `apps/api/.env` (never commit secrets).

## Money

- Integer centavos only. Never floats for authoritative amounts.
- Desktop converts pesos to centavos at the form edge with
  `tryParsePesos`; display uses `formatPesos`.

## Database and audit rules

- Every schema change is a migration.
- Posted financial records are reversed, never deleted or overwritten.
  Users, plans, areas, collectors, addresses and contacts are
  deactivated, never deleted. Subscribers use statuses
  (active/inactive/terminated/archived).
- Every mutation runs in one transaction and calls `writeAudit(tx, ...)`
  with the same transaction handle. `audit_logs` is append-only (DB
  trigger).
- Updates use `SELECT ... FOR UPDATE`, audit only fields that actually
  changed (`changedFields` in `db/query_helpers.ts`), and write no audit
  row on a no-op. Optional `reason`.
- Unique violations are mapped by constraint name (`violatedConstraint`).
- Separate concepts get separate endpoints and audit actions (status
  change, assignment change), not a generic update.

## API conventions

- Permissions are checked server-side from the DB on every request:
  `authenticate`, then `requirePermission("...")`. Hiding a menu item in
  React is cosmetic only.
- Services throw typed errors (`AuthError`, `PlanError`,
  `CollectionError`, `SubscriberError`) with `code` and `status`; routes
  map them with a `sendXError` helper.
- Validate every external input with Zod in `@bcis/shared`;
  `sendValidationError` returns `{ error: "VALIDATION", issues }`.
- Update schemas are `z.strictObject` with a `reason` field and a refine
  requiring at least one change besides `reason`. Codes cannot be edited.
- Business rules live in services and `@bcis/shared`, not in React.

## Electron conventions

- `contextIsolation` on, `nodeIntegration` off, session token only in
  the main process, renderer never touches the database.
- One dedicated IPC handler per API call (no generic proxy); ids go
  through `encodeURIComponent`; `authedRequest` is private to main;
  DTO types live in `preload/index.ts`.
- Reusable UI: `Badge`, `DataTable`, `MoneyField`, `TextField`,
  `Sidebar`/`Shell`. New screens follow the `PlanForm`/`PlansScreen`
  pattern (send only changed fields, map server issues to field errors,
  `UNAUTHENTICATED` calls `onExpired`).
- UI standard: clean, dense, professional. Financial values right-aligned
  with tabular numerals. Status shown with text plus color, never color
  alone.

## Testing conventions

- Helpers: `createTestDb`, `prepareTestDatabase`, `createTestUser`.
  TRUNCATE the tables under test; tests run sequentially against
  `bcis_test`.
- Route tests use `app.inject` with bearer tokens and demo roles
  (administrator, cashier, auditor, ...).
- Financial rules need unit and integration tests. The spec's acceptance
  tests AT-01 to AT-12 are mandatory.
- Assert audit rows, rollbacks on failure, and the no-op/no-audit case.

## Working rules

- Implement the smallest coherent feature, then migration/validation,
  then tests, then typecheck and tests, then review the diff for
  financial and security impact.
- Review generated migrations, SQL, security-sensitive code and money
  calculations before accepting them.
- Use synthetic demo data only. Never use real customer names, phone
  numbers, GCash details or passwords.
- Never print or log passwords, tokens or secrets.
- Commits are small and meaningful.

## Known gotchas

- Electron needed `pnpm approve-builds`.
- PowerShell POSTs need `-ContentType "application/json"`.
- Windows PowerShell 5.1 shows the peso sign garbled; files are UTF-8
  and fine.
- Local DB roles: `bcis_app` owns `bcis` and `bcis_test`.