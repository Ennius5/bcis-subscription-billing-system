# Security Review

BCIS Subscription Billing and Collection System. Phase 9, 2026-10-11.

Scope: the Fastify API (`apps/api`), the Electron desktop client (`apps/desktop`), the
PostgreSQL schema (`database/migrations`) and the backup files. Method: every requirement of
spec section 4.4 (and the related rules in 2.3 and 4.5) was checked against the code and, wherever
possible, against an automated test that fails if the protection is removed. Findings fixed during
the review are listed in section 3; risks that remain on purpose are in section 4.

## 1. Spec 4.4 requirements

| Requirement | How it is met | Evidence |
|---|---|---|
| Username/password authentication with secure hashing | Passwords hashed with argon2id (19 MiB, 2 iterations, 1 lane: OWASP minimum). Plain passwords are never stored, logged or audited. Unknown usernames take as long as wrong passwords, so they cannot be told apart. | `apps/api/src/auth/password.ts`, `auth/service.ts`; `auth/password.test.ts`, `auth/authorization.test.ts` |
| Account active/inactive state | `users.is_active`. Deactivation ends every session of that user immediately. Users are never deleted. | `admin/users.ts`; `admin/users.test.ts` (deactivating signs the user out at once) |
| RBAC with granular permissions | 28 permission codes (`subscriber.view` … `backup.restore`), 7 roles, many-to-many `roles`/`permissions`/`role_permissions`/`user_roles`. Permissions are read from the database on every request, so a role change applies at the next click. | `packages/shared/src/permissions.ts`, `auth/authenticate.ts` |
| Server-side authorization is mandatory | Every route uses `authenticate` and then `requirePermission(...)`. The route-guard test walks the live route table (119 routes) and fails if any route other than the 3 public ones answers without a session (401), or if any route other than the 3 own-account ones answers a signed-in user who has no role (403). Menus hidden in React are cosmetic only. | `security/route-guards.test.ts`; AT-10 in `auth/authorization.test.ts`, `admin/users.test.ts`, `backup/routes.test.ts` |
| Posted financial mutations are audited (actor, action, date/time, reason, old/new values) | Each mutation calls `writeAudit(tx, …)` with the same transaction, so the audit row and the change commit or roll back together. Updates record only the fields that changed; a no-op writes nothing. Reversals, voids, adjustments, status changes, restores and user changes require or accept a reason. | `audit/audit.ts`; `audit/audit.test.ts` (rollback), audit assertions in every service test |
| Audit logs are not editable through normal screens | A database trigger rejects every UPDATE and DELETE on `audit_logs`. The API has no write route for audit logs: the Audit Log screen is read-only. | `database/migrations/0004_audit_logs_append_only.sql`, `audit/routes.ts` |
| Uploaded payment proofs validated by type, size and safe storage path | Type detected from the file's first bytes (PNG/JPEG/WebP), not from its name. Size 1 byte to 5 MB. The stored name is a new UUID plus an extension chosen from the detected type, matched against a fixed pattern before use, inside one fixed folder. A database check repeats the type, size and SHA-256 rules. The integrity check confirms each file still matches its checksum. | `payments/proof-storage.ts`, migration 0014; `payments/*.test.ts`, `backup/restore.test.ts` |
| Passwords, secrets and confidential payment credentials are never logged | The logger redacts `Authorization` and `Cookie` headers and never logs request bodies. Audit values redact `password`, `passwordHash`, `temporaryPassword`, `currentPassword`, `newPassword`, `token`, `tokenHash` and `secret` at any depth. Password resets audit only that a reset happened. `pg_dump`/`pg_restore` receive the database password through `PGPASSWORD`, never on the command line. | `http/logging.ts`, `audit/audit.ts`, `backup/pg-tools.ts`; `http/error-handler.test.ts`, `audit/audit.test.ts`, `backup/service.test.ts` |
| Session lock/logout | Sign out on every screen ends the session on the server. Sessions also end after 30 minutes idle or 12 hours in total. Tokens are 256-bit random values; only their SHA-256 is stored. Deactivation, password reset and restore end sessions at once. | `auth/session.ts`; `auth/authorization.test.ts` |
| Sensible failed-login handling | 5 wrong passwords lock the account for 15 minutes; the lock is shown, and an owner can unlock it. The same limit applies to the current password on Change my password (fixed in this review, section 3). | `auth/service.ts`, `admin/users.ts`; `auth/authorization.test.ts`, `admin/users.test.ts` |

## 2. Related architectural rules (spec 2.3 and 4.5)

| Rule | How it is met |
|---|---|
| Renderer never connects to PostgreSQL | The renderer only calls `window.bcis.*`. Each call goes through one dedicated IPC handler in the main process, which calls the API. Only the API server holds database credentials. |
| `contextIsolation: true`, `nodeIntegration: false` | Set in `apps/desktop/src/main/index.ts`, plus `sandbox: true`. |
| Narrow typed preload API | `preload/index.ts` exposes one function per API call, never a generic request function. The main process checks each IPC argument's type, and ids go through `encodeURIComponent`. The session token stays in the main process. |
| Navigation and new windows | `will-navigate` is cancelled and `window.open` is denied, so the window can only show the app itself. |
| Content Security Policy | `default-src 'self'; script-src 'self'`; no inline scripts, no plugins (`object-src 'none'`), no frames, no form posts, no `<base>` rewriting. Images only from the app or `data:` (proof images arrive as data URLs from the main process). |
| Validation of every external input | Zod schemas in `@bcis/shared` validate every body, query and parameter. Update schemas are strict (unknown fields rejected). Raw SQL uses parameters or fixed table names only. |
| Transactions for multi-step financial posting | Every financial mutation runs in one transaction with row locks (`SELECT … FOR UPDATE`) and gapless numbering by locked counters. AT-09 runs them in parallel and proves numbers and balances stay correct. |
| Understandable errors, technical detail in logs | One error handler: users see a plain sentence and a reference; the stack trace goes to the daily log file under the same reference. |

## 3. Findings fixed during this review

1. **Unlimited guesses on Change my password.** A signed-in session could retry the current
   password without limit, so an unattended, signed-in PC could be used to guess it. Fix: the
   same rule as sign-in. The 5th wrong try locks the account for 15 minutes and ends every
   session. Test: `admin/users.test.ts`, "five wrong current passwords lock the account".
2. **No proof that every route is guarded.** AT-10 covered selected routes only. Fix: the API now
   records every route as it is registered, and `security/route-guards.test.ts` checks all of them.
   A route added later without a permission check fails the test suite.
3. **Electron permission requests.** Chromium could ask the user for camera, microphone or
   location access. Fix: every permission request and check is refused, because the app needs none.
   The installed app also has no developer menu.
4. **CSP gaps.** The policy did not mention `object-src`, `base-uri`, `form-action` or frames.
   Fix: all set to `'none'`.
5. **Response headers.** API replies now carry `X-Content-Type-Options: nosniff` and
   `Cache-Control: no-store`, so financial data is never cached. The 1 MB JSON body limit is now
   written out explicitly; proof uploads keep their own 5 MB limit.

## 4. Accepted risks

| Risk | Why it is accepted |
|---|---|
| The API speaks plain HTTP on the office LAN | All three PCs and the server are on one closed office network (spec 2.1). The deployment guide opens port 3000 to the LAN only, and PostgreSQL listens on localhost only. TLS would need a certificate authority the office does not have. Recommended before any access from outside the office. |
| No per-IP rate limit on sign-in | Each account locks after 5 failures, and there are only a few accounts on a closed LAN. |
| `pnpm audit`: `uuid` < 11.1.1 (moderate), via `exceljs` | The advisory affects `uuid` v3/v5/v6 when the caller supplies a buffer. `exceljs` only calls `v4()` with no buffer, so the flaw is not reachable. Revisit when `exceljs` updates. |
| `pnpm audit`: `esbuild` dev server (moderate), via `drizzle-kit` | A development-only tool used to generate migrations. Its dev server is never started and the package is not installed on the office PCs. |
| Backups are not encrypted | They live on the server PC next to the database and are as sensitive as the database itself. The deployment guide says to keep the server's Windows account protected and to store copies on an encrypted or locked-away drive. |
| No in-app "lock screen" | Sign out is on every screen, and an idle session ends after 30 minutes. Windows' own lock (Win+L) covers a short absence. |

## 5. Re-running the checks

```powershell
pnpm --filter @bcis/api test      # includes route guards, AT-09, AT-10, AT-12
pnpm --filter @bcis/shared test
pnpm lint
pnpm audit --prod
```
