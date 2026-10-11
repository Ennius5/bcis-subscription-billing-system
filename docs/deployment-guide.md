# Deployment Guide

BCIS Subscription Billing and Collection System: installing the server and the three office PCs,
backups, the three-PC concurrency test, updates and troubleshooting.

All commands are for Windows PowerShell. Replace values in `<angle brackets>`.

## 1. What runs where

```
PC 1: Owner/Admin   ─┐
PC 2: Cashier       ─┼── office LAN ──> Server PC: BCIS API (port 3000) ──> PostgreSQL 18 (localhost only)
PC 3: Operations    ─┘                              │
                                                    ├── apps\api\attachments\payment-proofs  (GCash proof images)
                                                    ├── apps\api\backups                     (daily verified backups)
                                                    └── apps\api\logs                        (daily log files, 30 days)
```

* The office PCs run the **BCIS Billing** desktop app. They never touch the database; every action
  goes to the API, which checks permissions, validates input and writes the audit trail.
* The server PC can also be one of the three office PCs, with the desktop app installed on it as well.
* PostgreSQL accepts connections from the server PC itself only. Only the API port (3000) is open to the LAN.

## 2. Requirements

| | Server PC | Office PCs |
|---|---|---|
| Windows | 10 or 11, 64-bit | 10 or 11, 64-bit |
| Software | Node.js 24, pnpm 11, PostgreSQL 18, Git | none (the installer contains everything) |
| Network | fixed LAN address (static IP or a DHCP reservation in the router) | same LAN as the server |
| Disk | room for the database plus about 30 backups | about 400 MB |

On every PC the office network must be set to **Private**, not Public: Settings › Network & Internet ›
(your connection) › Network profile type › Private. The firewall rule only opens the port on private networks.

## 3. Server PC setup (once)

### 3.1 Install the software

1. **PostgreSQL 18** from postgresql.org (EDB installer). Remember the password you choose for `postgres`.
   Keep the default `listen_addresses = 'localhost'`; do not open port 5432 to the network.
2. **Node.js 24 LTS** from nodejs.org (tick "Add to PATH").
3. **pnpm 11**: `npm install -g pnpm@11`
4. **Git**, then get the source:
   ```powershell
   cd C:\
   git clone <repository-url> BCIS-Subscription-Billing-System
   cd C:\BCIS-Subscription-Billing-System
   ```

### 3.2 Create the database role and databases

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE ROLE bcis_app LOGIN PASSWORD '<strong-app-password>'"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE bcis OWNER bcis_app"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE bcis_verify OWNER bcis_app"
```

`bcis_verify` is the scratch database for **Test restore** on the Backup & Restore screen. `bcis_app` is
deliberately not allowed to create databases, so this one is made here, once.

### 3.3 Configure the API

```powershell
Copy-Item .env.example apps\api\.env
notepad apps\api\.env
```

Set at least:

| Setting | Value |
|---|---|
| `DATABASE_URL` | `postgresql://bcis_app:<strong-app-password>@localhost:5432/bcis` |
| `NODE_ENV` | `production` (add the line) |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | the first owner account (password at least 10 characters) |
| `PG_BIN_DIR` | `C:\Program Files\PostgreSQL\18\bin` |
| `BACKUP_DIR` | e.g. `D:\BCIS\backups` (preferably a second disk) |

Delete the `TEST_DATABASE_URL` and `SEED_DEMO_PASSWORD` lines on a real server: no test or demo data belongs there.
`.env` holds the database password. It is never committed, and only administrators of the server PC should be able to read it.

### 3.4 Build, create the tables, create the owner

```powershell
pnpm install
pnpm --filter ./apps/api build
pnpm --filter ./apps/api db:migrate
pnpm --filter ./apps/api db:seed
```

`db:seed` creates the roles, the permissions and the owner account from `.env`. Running it again changes nothing.

### 3.5 Start the server at boot, schedule backups, open the firewall

Open PowerShell with **Run as administrator**, then:

```powershell
cd C:\BCIS-Subscription-Billing-System
powershell -ExecutionPolicy Bypass -File deploy\install-server.ps1
```

This registers:

* **BCIS API**, a scheduled task that starts the API at boot, before anyone signs in, and restarts it
  5 seconds after any stop (`deploy\run-api.ps1`; stops are written to `apps\api\logs\keeper.log`).
* **BCIS Backup**, a daily verified backup at 21:00. Use `-BackupTime "18:30"` to choose another time.
* **BCIS API (LAN)**, a firewall rule that opens TCP 3000 to the local subnet only, on private networks only.

The script ends by printing the address to enter on the office PCs, e.g. `http://192.168.1.10:3000`.
To remove the tasks and the rule later, run `deploy\uninstall-server.ps1`. Data is not touched.

### 3.6 Check

```powershell
Invoke-RestMethod http://localhost:3000/health/db       # status ok, database connected
Get-ScheduledTask -TaskName "BCIS*" | Select-Object TaskName, State
```

Restart the server PC once and check again: the API must come back without anyone signing in.

## 4. Office PC setup

1. **Build the installer** (on the development PC):
   ```powershell
   pnpm --filter @bcis/desktop dist
   ```
   The result is `apps\desktop\release\BCIS-Billing-Setup-<version>.exe`. Copy it to each PC (USB drive or a shared folder).
2. **Install**: run the file. The installer is not code-signed, so Windows SmartScreen may say
   "Windows protected your PC". Choose **More info › Run anyway**. Keep the default folder.
3. **Connect**: start BCIS Billing. On the sign-in screen, next to "Server", click **Change**, enter the
   address from step 3.5 and click **Test and save**. The address is only saved if a BCIS server answers.
   Each PC remembers its address.
4. **First sign-in** (owner, on PC 1): open Administration › Users and create an account for every staff member
   with the right roles. Each person gets a temporary password and must choose their own at first sign-in.
   Create a **second owner** account for emergencies, kept in a sealed envelope.

## 5. Backups and restore

### 5.1 Daily routine

* The **BCIS Backup** task runs every evening. Check Administration › Backup & Restore each morning:
  the newest backup should be **Verified**. A yellow banner appears when no good backup is newer than 24 hours.
* Before risky work (month-end billing, mass changes) click **Back up now** with a note.
* **Every week**, copy the newest backup folders from `BACKUP_DIR` to an external drive kept away from the
  server. A backup on the same disk does not survive a disk failure. Treat the drive like the cash box: it holds
  every subscriber's data.
* **Every month**, click **Test restore** on a recent backup. It restores into `bcis_verify` and runs the integrity
  check there, without touching live data.

### 5.2 Restoring (server still working)

Administration › Backup & Restore › **Restore…** on a Verified backup, type its number and a reason. The system
first takes a safety backup of the current data, locks everyone out, restores in one transaction (all or nothing),
puts the proof images back, keeps the backup history, runs the integrity check and signs everyone out.
Everything recorded after that backup is gone. To undo a restore, restore the safety copy it names.

### 5.3 Disaster recovery (server PC lost)

The Restore button needs the backup history, which went down with the old server. On the new server:

1. Do section 3.1 to 3.4 (skip `db:seed`).
2. Copy one backup folder from the external drive, e.g. to `D:\BCIS\restore\BK-000123_20261011-210000`.
3. Restore it into the empty database, as `bcis_app`:
   ```powershell
   $env:PGPASSWORD = "<strong-app-password>"
   & "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h localhost -U bcis_app -d bcis `
       --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error `
       "D:\BCIS\restore\BK-000123_20261011-210000\database.dump"
   Remove-Item Env:PGPASSWORD
   Copy-Item "D:\BCIS\restore\BK-000123_20261011-210000\proofs\*" "C:\BCIS-Subscription-Billing-System\apps\api\attachments\payment-proofs\" -Force
   ```
   (Create the `payment-proofs` folder first if it does not exist.)
4. Do section 3.5, sign in as an owner and click **Run integrity check**. Every line must pass.
   The restored backup itself appears in the history as *in progress* and is closed as *interrupted* after
   an hour. That is expected: the dump was taken while that backup was running.

## 6. Three-PC concurrency test (AT-09)

**Automated part**, from any PC with the source code on the LAN:

```powershell
$env:BCIS_API_URL = "http://<server-ip>:3000"
pnpm --filter ./apps/api concurrency
```

It needs the demo accounts (`demo_cashier`, `demo_admin`, `demo_supervisor`), so run it on a demo or test
installation, never on live data. Three clients sign in and work at the same moment: two post ₱1.00 payments,
one keeps reading. The script checks that no request failed, no receipt number repeated, every receipt names
the right user, permissions held and one sign-out left the others signed in. It then reverses its own test payments.
Afterwards, click **Run integrity check** on the Backup screen; every line must pass.

**Manual part**, on the three real PCs at the same time (screenshot each step):

| Step | PC 1 (Owner/Admin) | PC 2 (Cashier) | PC 3 (Operations) |
|---|---|---|---|
| 1 | Generate billing for the month | Receive a payment for subscriber A | Open the Outstanding list |
| 2 | Open subscriber A's ledger | Receive a payment for subscriber B | Record a field collection for subscriber C |
| 3 | Run integrity check | Print the receipt | Open the collector report |

Expected: no error messages, receipt numbers that follow each other without gaps or repeats, each payment showing
the right cashier, balances updated on every PC after a refresh, and a passing integrity check.

## 7. Updating to a new version

1. **Back up now** on the Backup & Restore screen.
2. On the server, as administrator:
   ```powershell
   cd C:\BCIS-Subscription-Billing-System
   Stop-ScheduledTask -TaskName "BCIS API"
   git pull
   pnpm install
   pnpm --filter ./apps/api build
   pnpm --filter ./apps/api db:migrate
   Start-ScheduledTask -TaskName "BCIS API"
   ```
3. Install the new `BCIS-Billing-Setup-<version>.exe` on each office PC (over the old one; the saved server address stays).
4. Run the integrity check.

Backups record which version made them. A backup made before a database change cannot be restored by a newer
version, and the screen says so.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Sign-in screen says **unreachable** | Is the server PC on? From the office PC: `Test-NetConnection <server-ip> -Port 3000`. If it fails: network profile Private on both PCs, firewall rule present (`Get-NetFirewallRule -DisplayName "BCIS API (LAN)"`), server IP unchanged. |
| "Something went wrong… reference: 3f9a1c0b2e" | Search today's `apps\api\logs\api.<date>.1.log` on the server for that reference: the full technical error is there. |
| "The database is not available right now" | Services › `postgresql-x64-18` running? Disk full? |
| API not running after a restart | `Get-ScheduledTask "BCIS API"`; read `apps\api\logs\keeper.log` and the newest `api.*.log`. |
| Backup **Failed**: "pg_dump was not found" | `PG_BIN_DIR` in `apps\api\.env`. |
| Scheduled backup shows a failed last run | Task Scheduler › BCIS Backup › History; Backup & Restore screen › Details shows the error. |
| A user is **Locked** | 5 wrong passwords; it clears after 15 minutes, or an owner clicks **Unlock** (Administration › Users). |
| Owner forgot the password | The second owner (section 4) resets it in Administration › Users. |
| "The system is being restored" | A restore is running. Wait, then sign in again. |

## 9. Security checklist

* Office network on **Private**; the API port open to the local subnet only; PostgreSQL on localhost only.
* `apps\api\.env` and the backup folders readable only by administrators of the server PC.
* Staff have their own accounts and roles; nobody shares the owner account.
* Backups copied off the server weekly, stored like cash.
* The full review is in [security-review.md](security-review.md).
