// Takes the UI screenshots (deliverable D7, and the pictures in the user manual) from the real
// desktop app against the demo data: starts a local API on the database in apps/api/.env, builds
// and launches the Electron app with Playwright, signs in as the demo users and photographs each
// screen into tests/screenshots/. It only looks: nothing is posted, verified or saved.
//
//   pnpm screenshots            (seed the demo data first: database/seeds/README.md)
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(repo, "apps/api");
const desktopDir = path.join(repo, "apps/desktop");
const outDir = path.join(repo, "tests/screenshots");
const PORT = 3999;
const API = `http://127.0.0.1:${PORT}`;

const env = Object.fromEntries(
  readFileSync(path.join(apiDir, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const PASSWORD = env.SEED_DEMO_PASSWORD;
if (!PASSWORD) throw new Error("SEED_DEMO_PASSWORD is not set in apps/api/.env");

const shots = [];

async function main() {
  console.log("Building the desktop app...");
  const build = spawnSync(process.execPath, [path.join(desktopDir, "node_modules/electron-vite/bin/electron-vite.js"), "build"], {
    cwd: desktopDir,
    stdio: "ignore",
  });
  if (build.status !== 0) throw new Error("electron-vite build failed");

  console.log("Starting a local API on the demo database...");
  const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiDir,
    env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: String(PORT), LOG_LEVEL: "warn" },
    stdio: "ignore",
  });
  try {
    await waitForApi();
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const electronPath = createRequire(path.join(desktopDir, "package.json"))("electron");
    const app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(desktopDir, "out/main/index.js")],
      // VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE")), BCIS_API_URL: API },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(1440, 900);
        win.center();
      });
      await tour(page);
    } finally {
      await app.close();
    }

    await writeFile(
      path.join(outDir, "README.md"),
      [
        "# UI screenshots (D7)",
        "",
        "Taken from the desktop app against the synthetic demo dataset by `pnpm screenshots` (Playwright drives the real Electron app; nothing is posted).",
        "",
        "| File | Screen |",
        "|---|---|",
        ...shots.map((s) => `| \`${s.file}\` | ${s.caption} |`),
        "",
      ].join("\n"),
    );
    console.log(`Wrote ${shots.length} screenshots to tests/screenshots/`);
  } finally {
    api.kill();
  }
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/health/db`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The API did not start (is PostgreSQL running and .env correct?)");
}

/* ------------------------------- Helpers ------------------------------- */

async function settle(page) {
  await page.waitForFunction(() => !document.body.innerText.includes("Loading…"), null, { timeout: 15_000 });
  await page.waitForTimeout(400);
}

async function shot(page, file, caption) {
  await page.mouse.move(2, 2); // no hover highlight in the picture
  await settle(page);
  await page.screenshot({ path: path.join(outDir, `${file}.png`) });
  shots.push({ file: `${file}.png`, caption });
  console.log(`  ${file}`);
}

const nav = (page) => page.getByRole("navigation", { name: "Main navigation" });

/** Opens a menu entry, expanding its group first if needed. */
async function go(page, group, item) {
  const menu = nav(page);
  const entry = menu.getByRole("button", { name: item ?? group, exact: true });
  if (item && !(await entry.isVisible())) await menu.getByRole("button", { name: group, exact: true }).click();
  await entry.click();
  await settle(page);
}

async function signIn(page, username, password = PASSWORD) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await nav(page).waitFor({ timeout: 10_000 });
  await settle(page);
}

async function signOut(page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
}

/* -------------------------------- The tour -------------------------------- */

async function tour(page) {
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await page.getByLabel("Username").fill("demo_admin");
  await shot(page, "01-sign-in", "Sign-in, with the server address below");

  await signIn(page, "demo_admin");
  await shot(page, "02-dashboard", "Dashboard: KPIs, billing vs collection, aging, payment methods, collectors");

  await go(page, "Subscribers", "All Subscribers");
  await shot(page, "03-subscribers", "All Subscribers with search and filters");

  // The subscriber with the most history (the one in the Statement of Account sample).
  const search = page.getByLabel("Search subscribers");
  await search.fill("BCIS-000017");
  await page.getByRole("button", { name: /BCIS-000017/ }).first().click();
  await settle(page);
  await shot(page, "04-profile-overview", "Subscriber profile: Overview (details, balance, assignment, addresses, contacts)");
  for (const [tab, file, caption] of [
    ["Services", "05-profile-services", "Subscriber profile: Services"],
    ["Billing", "06-profile-billing", "Subscriber profile: Billing (invoices)"],
    ["Payments", "07-profile-payments", "Subscriber profile: Payments and GCash submissions"],
    ["Ledger", "08-profile-ledger", "Subscriber profile: Ledger and Statement of Account"],
    ["Collection", "09-profile-collection", "Subscriber profile: Collection batches"],
    ["Service history", "10-profile-history", "Subscriber profile: Service and account history"],
    ["Audit", "11-profile-audit", "Subscriber profile: Audit trail"],
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await shot(page, file, caption);
  }

  await go(page, "Subscribers", "New Subscriber");
  await shot(page, "12-new-subscriber", "New Subscriber form");

  await go(page, "Services");
  await shot(page, "13-services", "Services: awaiting installation, suspended, reconnections");

  await go(page, "Billing", "Generate Billing");
  await shot(page, "14-generate-billing", "Generate Billing: draft, review, finalize");
  await go(page, "Billing", "Invoices");
  await shot(page, "15-invoices", "Invoices with status");

  await go(page, "Payments", "Receive Payment");
  await page.getByPlaceholder("Account no., name, phone or address").fill("BCIS-000017");
  await page.getByRole("button", { name: /BCIS-000017/ }).first().click();
  await settle(page);
  await page.getByLabel("Amount received").fill("999.00");
  await shot(page, "16-receive-payment", "Receive Payment: balance, open invoices oldest first, allocation preview (not posted)");

  await go(page, "Payments", "Payment History");
  await shot(page, "17-payment-history", "Payment History (posted and reversed)");
  await page.getByRole("button", { name: /^RCPT-/ }).first().click();
  await shot(page, "18-receipt", "Official receipt, ready to print");

  await go(page, "Payments", "GCash Verification");
  const pending = page.locator("main li button").first();
  if (await pending.isVisible()) await pending.click();
  await shot(page, "19-gcash-verification", "GCash Verification: submission with proof image, verify or reject");

  await go(page, "Collections", "Collection Batches");
  await shot(page, "20-collection-batches", "Collection Batches");
  await page.getByRole("button", { name: "CB-000004", exact: true }).click();
  await shot(page, "21-batch-reconciliation", "Batch reconciled with a ₱500 shortage and its reason");
  // Leaving the screen and coming back shows the list again.
  await go(page, "Collections", "Collectors");
  await shot(page, "23-collectors", "Collectors and their performance");
  await go(page, "Collections", "Collection Batches");
  await page.getByRole("button", { name: "CB-000005", exact: true }).click();
  await shot(page, "22-batch-in-progress", "Batch in the field: route sheet, collections, remittance");

  await go(page, "Receivables", "Outstanding");
  await shot(page, "24-outstanding", "Outstanding balances");
  await go(page, "Receivables", "Overdue");
  await shot(page, "25-overdue", "Overdue accounts with arrears");
  await go(page, "Receivables", "Aging");
  await shot(page, "26-aging", "AR aging by bucket");
  await go(page, "Receivables", "Suspension Candidates");
  await shot(page, "27-suspension-candidates", "Suspension candidates (advice) and reconnections");

  await go(page, "Reports");
  await shot(page, "28-reports", "Reports with PDF and XLSX export");

  await go(page, "Administration", "Audit Log");
  await shot(page, "29-audit-log", "Audit Log");

  // Users, Settings and Backup belong to the owner. Uses the owner from .env (db:seed); skipped
  // if that password was changed since.
  await signOut(page);
  try {
    await signIn(page, env.SEED_ADMIN_USERNAME ?? "admin", env.SEED_ADMIN_PASSWORD ?? "");
    await go(page, "Administration", "Users");
    await shot(page, "30-users", "Users and roles (owner)");
    await go(page, "Administration", "Backup & Restore");
    await shot(page, "31-backup-restore", "Backup & Restore and integrity checks (owner)");
    await go(page, "Administration", "Settings");
    await shot(page, "32-settings", "Settings: grace period and suspension threshold (owner)");
    await signOut(page);
  } catch {
    console.warn("  (owner sign-in failed: Users, Backup and Settings screenshots skipped)");
    await page.reload();
    await page.getByRole("button", { name: "Sign in" }).waitFor();
  }

  // A lower-privileged account sees less, and the server refuses the rest anyway.
  await signIn(page, "demo_cashier");
  await shot(page, "33-cashier-menu", "Signed in as a cashier: only the cashier's screens");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
