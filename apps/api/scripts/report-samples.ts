// Exports every report as PDF and XLSX from the database in .env (the seeded demo data) into
// reports-samples/, for deliverable D6. Runs the API in-process and signs in as demo_admin, so
// each file is exactly what a user gets from the Export buttons (and each export is audited).
//
//   pnpm --filter ./apps/api report-samples
//
// Needs the demo dataset (database/seeds/README.md) and SEED_DEMO_PASSWORD in .env.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { addMonths, periodBounds, periodLabel, periodOf } from "@bcis/shared";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { dbToday } from "../src/db/query_helpers";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoDir, "reports-samples");

interface Sample {
  file: string;
  title: string;
  shows: string;
  path: string;
  query?: Record<string, string>;
}

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === "production") throw new Error("Refusing to export samples when NODE_ENV=production");
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) throw new Error("SEED_DEMO_PASSWORD is not set in .env");

  const { db, pool } = createDb(config.DATABASE_URL);
  const app = buildApp({ ...config, LOG_LEVEL: "warn" }, { db, pool });
  try {
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "demo_admin", password } });
    if (login.statusCode !== 200) throw new Error(`Could not sign in as demo_admin (HTTP ${login.statusCode}). Is the demo data seeded?`);
    const token = login.json<{ token: string }>().token;

    const today = await dbToday(db);
    const thisMonth = periodOf(today);
    const lastMonth = addMonths(thisMonth, -1);
    const firstMonth = addMonths(thisMonth, -3);
    const { start: lastStart, end: lastEnd } = periodBounds(lastMonth);
    const rangeStart = periodBounds(firstMonth).start;

    // The Statement of Account of the subscriber with the most history who still owes something.
    const pick = await db.execute<{ id: string; account_number: string }>(sql`
      SELECT s.id, s.account_number
      FROM subscribers s JOIN ledger_entries l ON l.subscriber_id = s.id
      GROUP BY s.id, s.account_number
      HAVING sum(l.debit_centavos - l.credit_centavos) > 0
      ORDER BY count(*) DESC, s.account_number LIMIT 1`);
    const soa = pick.rows[0];
    if (!soa) throw new Error("No subscriber with a balance found. Is the demo data seeded?");

    const samples: Sample[] = [
      {
        file: `01-collections-${lastMonth}`,
        title: `Monthly collection report, ${periodLabel(lastMonth)}`,
        shows: "Collections per day and per payment method, reversals, net collected.",
        path: "/reports/collections/export",
        query: { from: lastStart, to: lastEnd, groupBy: "day" },
      },
      {
        file: "02-ar-aging",
        title: `AR aging as of ${today}`,
        shows: "Open balances in current, 1-30, 31-60, 61-90 and 90+ day buckets; unapplied credit; net receivable.",
        path: "/receivables/aging/export",
      },
      {
        file: `03-statement-of-account-${soa.account_number}`,
        title: `Statement of Account, ${soa.account_number}`,
        shows: "The subscriber's ledger, open invoices, aging and balance.",
        path: `/subscribers/${soa.id}/statement/export`,
      },
      {
        file: `04-collector-performance-${firstMonth}-to-${thisMonth}`,
        title: `Collector remittance and performance, ${periodLabel(firstMonth)} to today`,
        shows: "Per collector: batches, expected, collected, remitted, shortages and overages, collection rate.",
        path: "/collection-reports/collectors/export",
        query: { from: rangeStart, to: today },
      },
      {
        file: `05-billing-vs-collection-${firstMonth}-to-${thisMonth}`,
        title: `Billing vs collection, ${periodLabel(firstMonth)} to ${periodLabel(thisMonth)}`,
        shows: "Billed, adjustments, net billed, collected, collection rate and gap per month.",
        path: "/reports/billing-vs-collection/export",
        query: { from: firstMonth, to: thisMonth },
      },
      {
        file: `06-revenue-by-plan-${firstMonth}-to-${thisMonth}`,
        title: `Revenue by plan, ${periodLabel(firstMonth)} to ${periodLabel(thisMonth)}`,
        shows: "Net billed per plan and month.",
        path: "/reports/revenue/export",
        query: { from: firstMonth, to: thisMonth, dimension: "plan" },
      },
      {
        file: "07-subscriber-master-list",
        title: "Subscriber master list",
        shows: "Every subscriber with status, area, collector, services and balance.",
        path: "/reports/subscribers/export",
      },
      {
        file: `08-exceptions-${firstMonth}-to-${thisMonth}`,
        title: "Exceptions register (adjustments, reversals, voids)",
        shows: "Every adjustment, payment reversal and invoice void with who and why.",
        path: "/reports/exceptions/export",
        query: { from: rangeStart, to: today },
      },
      {
        file: `09-user-activity-${thisMonth}`,
        title: "User activity",
        shows: "Actions per user from the audit trail.",
        path: "/reports/user-activity/export",
        query: { from: periodBounds(thisMonth).start, to: today },
      },
    ];

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    for (const sample of samples) {
      for (const format of ["pdf", "xlsx"] as const) {
        const url = `${sample.path}?${new URLSearchParams({ ...sample.query, format }).toString()}`;
        const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
        if (res.statusCode !== 200) throw new Error(`${sample.title} (${format}): HTTP ${res.statusCode} ${res.body.slice(0, 200)}`);
        await writeFile(path.join(outDir, `${sample.file}.${format}`), res.rawPayload);
      }
      console.log(`Exported ${sample.file} (pdf, xlsx)`);
    }

    const readme = [
      "# Report samples (D6)",
      "",
      `Exported on ${today} from the synthetic demo dataset (\`database/seeds/README.md\`) with the app's own Export buttons' endpoints, signed in as \`demo_admin\`. Regenerate with \`pnpm --filter ./apps/api report-samples\`.`,
      "",
      "Every report is available as PDF (to print or send) and XLSX (to analyse); both are built from the same report data, so they show the same figures. The totals are checked against the underlying invoices and payments by `apps/api/src/acceptance/reconciliation.test.ts`.",
      "",
      "| Files | Report | What it shows |",
      "|---|---|---|",
      ...samples.map((s) => `| \`${s.file}.pdf\`, \`.xlsx\` | ${s.title} | ${s.shows} |`),
      "",
      "Printed receipts and collection route sheets are printed from the desktop app; see `tests/screenshots/`.",
      "",
    ];
    await writeFile(path.join(outDir, "README.md"), readme.join("\n"));
    console.log(`Wrote ${samples.length * 2} files and README.md to reports-samples/`);
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
