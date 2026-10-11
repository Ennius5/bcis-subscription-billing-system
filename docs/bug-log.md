# Bug Log

Defects found while building and testing the system, with root cause, fix and the test or
check that now guards against them (spec 7.1: "bug log showing at least discovered issue, root
cause, fix and regression test"). Most were caught by the step's own tests or review before the
step was committed, so the fix is in the same commit as the feature.

Severity: **High** = wrong money, data or security; **Medium** = a feature fails or misleads;
**Low** = cosmetic, tooling or demo-only.

| ID | Found | Area | Severity | Summary | Status |
|---|---|---|---|---|---|
| BUG-01 | 2026-10-09 | Desktop forms | Medium | Forms that stay open after saving were stuck on "Saving…" | Fixed |
| BUG-02 | 2026-10-11 | Users API | High | User list showed every user with no roles | Fixed |
| BUG-03 | 2026-10-11 | Security | High | Unlimited guesses at the current password on "Change my password" | Fixed |
| BUG-04 | 2026-10-11 | Security | Medium | Only selected routes were proven to check permissions | Fixed |
| BUG-05 | 2026-10-11 | Electron | Medium | The renderer could prompt for camera, microphone or location | Fixed |
| BUG-06 | 2026-10-11 | Build | Medium | Shared package type-checked without strict mode since the start | Fixed |
| BUG-07 | 2026-10-11 | Installer | Medium | Installer build failed: Electron binaries missing | Fixed |
| BUG-08 | 2026-10-11 | Tests | Low | Backup tests could not empty `backup_history` | Fixed |
| BUG-09 | 2026-10-11 | UI | Medium | Warning text failed the 4.5:1 contrast minimum | Fixed |
| BUG-10 | 2026-10-11 | Demo data | Medium | Suspended demo services had no unpaid bills | Fixed |
| BUG-11 | 2026-10-11 | Demo data | Low | The collector-shortage example never happened | Fixed |
| BUG-12 | 2026-10-11 | Demo data | Low | Outage rebate aimed at an already-paid bill | Fixed |

---

## BUG-01 Forms that stay open after saving were stuck on "Saving…"

- **Found:** building the Record collection form (Phase 6), which stays open for the next entry.
- **Symptom:** after a successful save the button kept saying "Saving…" and stayed disabled.
- **Root cause:** `useSave` reset its `saving` flag only on failure. Every earlier form closed
  itself on success, so the flag never mattered until a form stayed on screen.
- **Fix:** reset `saving` before handling the result, on every path
  (`apps/desktop/src/renderer/src/service-accounts/useSave.ts`).
- **Regression check:** Record collection is used repeatedly in the batch workflow and in the
  demo; manual check in the Collection Batches screen.
- **Commit:** `efe1274`

## BUG-02 User list showed every user with no roles

- **Found:** by the step's own route test before commit (Phase 9, user management).
- **Symptom:** `GET /admin/users` returned each user with an empty role list.
- **Root cause:** the roles were read with a correlated subquery written with Drizzle's
  `${users.id}`. Drizzle printed it as a bare `"id"`, which PostgreSQL resolved to `roles.id`
  inside the subquery, so it never matched.
- **Fix:** the outer column is written fully qualified, `"users"."id"`
  (`apps/api/src/admin/users.ts`).
- **Regression test:** `apps/api/src/admin/users.test.ts`, "lists users with roles and never
  returns password hashes".
- **Commit:** `4982c3a`

## BUG-03 Unlimited guesses at the current password on "Change my password"

- **Found:** security review (Phase 9).
- **Symptom:** a signed-in session could try current passwords without limit, so an unattended
  PC could be used to guess the password. Sign-in itself was already limited.
- **Root cause:** the lockout rule lived only in the sign-in service.
- **Fix:** the same rule as sign-in: the 5th wrong current password locks the account for
  15 minutes and ends every session (`apps/api/src/admin/users.ts`).
- **Regression test:** `apps/api/src/admin/users.test.ts`, "five wrong current passwords lock
  the account and end the session, like sign-in".
- **Commit:** `c358cc7`

## BUG-04 Only selected routes were proven to check permissions

- **Found:** security review (Phase 9).
- **Symptom:** none visible; the risk was a route added later without `requirePermission`.
- **Root cause:** authorization tests (AT-10) listed routes by hand.
- **Fix:** the API records every route as it is registered; a test calls all of them without a
  token (expects 401) and as a user with no roles (expects 403).
- **Regression test:** `apps/api/src/security/route-guards.test.ts` (fails if any route is
  unguarded).
- **Commit:** `c358cc7`

## BUG-05 The renderer could prompt for camera, microphone or location

- **Found:** security review (Phase 9).
- **Root cause:** Electron's default permission handlers allow Chromium to ask.
- **Fix:** every permission request and check is refused; the installed app has no developer
  menu; the Content Security Policy now also sets `object-src`, `base-uri`, `form-action` and
  frames to `'none'` (`apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/index.html`).
- **Regression check:** `docs/security-review.md` section 5 (re-running the checks).
- **Commit:** `c358cc7`

## BUG-06 Shared package type-checked without strict mode since the start

- **Found:** the production build (esbuild) failed reading `packages/shared/tsconfig.json` (Phase 9).
- **Symptom:** the file was empty, so `pnpm --filter @bcis/shared typecheck` had been running with
  TypeScript's defaults instead of the strict settings. Seven type errors in test files had gone
  unnoticed (none in the shipped rule code).
- **Root cause:** the file was created empty when the package was scaffolded.
- **Fix:** it now extends `tsconfig.base.json` (strict); the seven test errors were fixed.
- **Regression check:** the shared typecheck runs before every commit, now strict.
- **Commit:** `884fc42`

## BUG-07 Installer build failed: Electron binaries missing

- **Found:** first `pnpm --filter @bcis/desktop dist` (Phase 9).
- **Symptom:** electron-builder stopped: `electronDist` folder not found.
- **Root cause:** adding electron-builder made pnpm create a second copy of Electron in its store,
  and pnpm 11 does not run a package's install script unless `allowBuilds` permits it, so the
  binaries were never downloaded into that copy.
- **Fix:** `allowBuilds: electron: true` in `pnpm-workspace.yaml`, `node install.js` run once in
  the new copy; documented in CLAUDE.md "Known gotchas" and the deployment guide.
- **Regression check:** the installer builds (`apps/desktop/release/BCIS-Billing-Setup-*.exe`).
- **Commit:** `884fc42`

## BUG-08 Backup tests could not empty `backup_history`

- **Found:** running the backup tests after adding integrity checks (Phase 9).
- **Root cause:** `integrity_checks` references `backup_history`, so truncating the history alone
  is refused by PostgreSQL.
- **Fix:** tests truncate both tables together.
- **Regression check:** `apps/api/src/backup/*.test.ts` run in every test pass.
- **Commit:** `0c64f14`

## BUG-09 Warning text failed the 4.5:1 contrast minimum

- **Found:** measuring every text colour against its background during the theme change.
- **Symptom:** warning text (`#d97706` on white) measured 3.2:1, below the 4.5:1 needed for normal
  text; success text was 3.8:1. Readability for staff on older monitors.
- **Root cause:** the tones were Tailwind defaults chosen for icons and fills, not body text.
- **Fix:** warning `#b45309` (5.0:1), success `#047857` (5.5:1), danger `#c81e1e`, muted
  `#4d5b70`; gel buttons tuned so white labels stay at 4.7:1 or more
  (`apps/desktop/src/renderer/src/styles.css`). Alert boxes on the glass sheet got solid tints.
- **Regression check:** contrast figures recorded in the theme comments; CLAUDE.md requires
  4.5:1 for new UI.
- **Commit:** `2d1de47`

## BUG-10 Suspended demo services had no unpaid bills

- **Found:** designing the full demo dataset (Phase 10).
- **Symptom:** the seed suspended services "for unpaid balance" before any billing existed, so the
  suspended accounts owed nothing.
- **Root cause:** billing only bills services that are active when it runs (correct behaviour).
  The seed applied suspensions and terminations up front instead of on their dates.
- **Fix:** the seed now replays the last four months day by day; suspensions happen on their
  date after the unpaid months were billed (`apps/api/src/db/seed-demo-activity.ts`).
- **Regression test:** `apps/api/src/acceptance/reconciliation.test.ts` seeds the full dataset
  and checks overdue accounts in every aging bucket.
- **Commit:** `3b61f91`

## BUG-11 The collector-shortage example never happened

- **Found:** checking the first seeded dataset against spec section 8.
- **Symptom:** collector COL-02's batches were cancelled with nothing collected, so the ₱500
  shortage example was missing.
- **Root cause:** field payers were chosen as `index % 3 == 1`, and areas also rotate by three,
  so every field payer lived in one collector's area.
- **Fix:** field payers are every fourth subscriber, which spreads them over all areas.
- **Regression check:** the seed summary prints batches per collector; the reconciliation test
  runs on the same data.
- **Commit:** `3b61f91`

## BUG-12 Outage rebate aimed at an already-paid bill

- **Found:** first seed run (Phase 10). The system refused it correctly
  (`ADJUSTMENT_NOT_ALLOWED`: nothing is owed on this invoice).
- **Root cause:** the seed picked a subscriber whose due date fell before the rebate date, so
  they had already paid.
- **Fix:** the rebate goes to a subscriber whose bill is due on or after the 15th, with at least
  one installed service.
- **Commit:** `3b61f91`
