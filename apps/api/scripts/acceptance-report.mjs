// Runs the acceptance suite (AT-01..AT-12) and the full automated test suites, then writes
// tests/acceptance-test-report.md and .pdf (spec 7.1 and deliverable D5).
//
//   pnpm --filter ./apps/api acceptance            acceptance suite + all tests
//   pnpm --filter ./apps/api acceptance --quick    acceptance suite only
//
// Uses the test database (TEST_DATABASE_URL), like `pnpm test`. Exits non-zero if any test fails;
// the report is written either way, so a failure is documented rather than hidden.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToPdf } from "../../../scripts/md-to-pdf.mjs";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(apiDir, "../..");
const sharedDir = path.join(repoDir, "packages/shared");
const outMd = path.join(repoDir, "tests/acceptance-test-report.md");
const quick = process.argv.includes("--quick");

/** Other automated tests that cover the same rule at the unit or integration level. */
const SUPPORTING = {
  "AT-01": ["apps/api/src/payments/service.test.ts", "packages/shared/src/allocation.test.ts"],
  "AT-02": ["apps/api/src/payments/service.test.ts", "packages/shared/src/allocation.test.ts"],
  "AT-03": ["apps/api/src/payments/service.test.ts", "packages/shared/src/allocation.test.ts"],
  "AT-04": ["apps/api/src/payments/service.test.ts", "packages/shared/src/allocation.test.ts"],
  "AT-05": ["apps/api/src/payments/gcash.test.ts", "apps/api/src/payments/routes.test.ts", "apps/api/src/payments/schema.test.ts"],
  "AT-06": ["apps/api/src/payments/service.test.ts"],
  "AT-07": ["apps/api/src/collection/reconciliation.test.ts", "apps/api/src/collection/batch-routes.test.ts", "packages/shared/src/collection-batches.test.ts"],
  "AT-08": ["apps/api/src/collection/reconciliation.test.ts", "apps/api/src/collection/batch-routes.test.ts", "packages/shared/src/collection-batches.test.ts"],
  "AT-09": ["apps/api/src/concurrency/at09.test.ts", "apps/api/src/concurrency/three-clients.ts (manual, 3 PCs)"],
  "AT-10": ["apps/api/src/security/route-guards.test.ts", "apps/api/src/admin/users.test.ts", "apps/api/src/backup/routes.test.ts", "apps/api/src/auth/authorization.test.ts"],
  "AT-11": ["apps/api/src/billing/service.test.ts", "apps/api/src/billing/schema.test.ts"],
  "AT-12": ["apps/api/src/backup/restore.test.ts"],
};

function vitest(cwd, outputFile, args = [], env = {}) {
  // Vitest's own entry point, run with this Node: no shell needed on Windows.
  const bin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [bin, "run", ...args, "--reporter=json", `--outputFile=${outputFile}`], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (!existsSync(outputFile)) throw new Error(`Vitest produced no results in ${cwd}`);
  return result.status === 0;
}

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const work = await mkdtemp(path.join(os.tmpdir(), "bcis-acceptance-report-"));
try {
  console.log("Running the acceptance suite (AT-01..AT-12)...");
  const evidenceFile = path.join(work, "evidence.json");
  const acceptanceOk = vitest(apiDir, path.join(work, "acceptance.json"), ["src/acceptance"], {
    ACCEPTANCE_EVIDENCE: evidenceFile,
  });
  const acceptance = JSON.parse(await readFile(path.join(work, "acceptance.json"), "utf8"));
  const run = existsSync(evidenceFile) ? JSON.parse(await readFile(evidenceFile, "utf8")) : { evidence: [] };

  let suites = null;
  if (!quick) {
    console.log("Running all API tests...");
    const apiOk = vitest(apiDir, path.join(work, "api.json"));
    console.log("Running all shared tests...");
    const sharedOk = vitest(sharedDir, path.join(work, "shared.json"));
    suites = {
      ok: apiOk && sharedOk,
      api: JSON.parse(await readFile(path.join(work, "api.json"), "utf8")),
      shared: JSON.parse(await readFile(path.join(work, "shared.json"), "utf8")),
    };
  }

  const results = acceptance.testResults.flatMap((file) => file.assertionResults);
  const resultFor = (id) => results.find((r) => r.title.startsWith(id));
  const ids = Object.keys(SUPPORTING);
  const allPassed = acceptanceOk && ids.every((id) => resultFor(id)?.status === "passed") && (suites?.ok ?? true);

  const commit = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain") !== "";
  const generatedAt = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "long", timeStyle: "short" });
  const verdict = (status) => (status === "passed" ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>');
  const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

  const lines = [
    "# Acceptance Test Report",
    "",
    "BCIS Subscription Billing and Collection System: mandatory acceptance tests (spec section 7) and automated test evidence (spec 7.1, deliverable D5).",
    "",
    "| | |",
    "|---|---|",
    `| Generated | ${generatedAt} (Asia/Manila) |`,
    `| Source | commit \`${commit || "unknown"}\`${dirty ? " plus uncommitted changes" : ""} |`,
    `| Environment | Node ${process.version}, PostgreSQL ${run.postgres ?? "unknown"}, ${os.type()} ${os.release()} |`,
    `| Billing months used | ${run.months ? `${run.months.monthA} (the spec's "August"), ${run.months.monthB} ("September"), ${run.months.monthC}` : "n/a"} |`,
    `| Overall result | ${allPassed ? verdict("passed") + " all tests passed" : verdict("failed") + " see below"} |`,
    "",
    "## How these tests run",
    "",
    "The acceptance suite (`apps/api/src/acceptance/acceptance.test.ts`) uses the spec's own test data and drives the system through its HTTP API, exactly as the desktop app does: each user signs in and sends requests with their session token, and the server checks permissions on every request. Plans, subscribers and installations are set up directly; every step being tested (billing, payments, GCash, reversals, collector batches, backups) goes over HTTP. The tests run against a dedicated test database (`bcis_test`).",
    "",
    "To reproduce: `pnpm --filter ./apps/api acceptance` (this report), or `pnpm --filter ./apps/api test` (all API tests).",
    "",
    "## Summary",
    "",
    "| ID | Scenario | Test data | Expected result | Result | Time |",
    "|---|---|---|---|---|---|",
    ...ids.map((id) => {
      const e = run.evidence.find((x) => x.id === id);
      const r = resultFor(id);
      return `| ${id} | ${cell(e?.title ?? r?.title ?? "")} | ${cell(e?.data ?? "")} | ${cell(e?.expected ?? "")} | ${verdict(r?.status)} | ${r ? `${Math.round(r.duration)} ms` : ""} |`;
    }),
    "",
    "## Results in detail",
    "",
  ];

  for (const id of ids) {
    const e = run.evidence.find((x) => x.id === id);
    const r = resultFor(id);
    lines.push(`### ${id} ${e?.title ?? ""} ${verdict(r?.status)}`, "");
    if (e) {
      lines.push(`**Test data:** ${e.data}`, "", `**Expected (spec):** ${e.expected}`, "", "**Observed:**", "");
      for (const o of e.observed) lines.push(`- ${o}`);
      lines.push("");
    }
    if (r?.status !== "passed") {
      lines.push("**Failure:**", "", "```", ...(r?.failureMessages ?? ["Test did not run"]).map((m) => m.split("\n").slice(0, 8).join("\n")), "```", "");
    }
    lines.push(`Automated test: \`${r?.title ?? id}\``, "", `Also covered by: ${SUPPORTING[id].map((f) => `\`${f}\``).join(", ")}`, "");
  }

  if (suites) {
    const row = (name, report) =>
      `| ${name} | ${report.testResults.length} | ${report.numTotalTests} | ${report.numPassedTests} | ${report.numFailedTests} |`;
    lines.push(
      "## All automated tests",
      "",
      "Unit tests for the domain and money rules (`packages/shared`), and integration tests for every API service and route against PostgreSQL (`apps/api`), including the acceptance suite above.",
      "",
      "| Package | Test files | Tests | Passed | Failed |",
      "|---|---|---|---|---|",
      row("@bcis/shared (domain rules, money, allocation, validation)", suites.shared),
      row("@bcis/api (services, routes, security, backup, concurrency)", suites.api),
      "",
    );
    const failed = [suites.shared, suites.api].flatMap((s) =>
      s.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => `${path.relative(repoDir, f.name)}: ${a.fullName}`)),
    );
    if (failed.length > 0) lines.push("Failed tests:", "", ...failed.map((f) => `- ${f}`), "");
  }

  lines.push(
    "## Manual and desktop evidence",
    "",
    "Desktop workflows are checked by hand against the same rules; screenshots are in `tests/screenshots/`, sample report files in `reports-samples/`, and defects found with their fixes in `docs/bug-log.md`.",
    "",
  );

  await writeFile(outMd, lines.join("\n"));
  console.log(`Wrote ${path.relative(repoDir, outMd)}`);
  const pdf = await markdownToPdf(outMd);
  console.log(`Wrote ${path.relative(repoDir, pdf)}`);
  console.log(allPassed ? "All tests passed." : "Some tests FAILED: see the report.");
  process.exitCode = allPassed ? 0 : 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
