// Writes the reference parts of the technical documentation from the system itself, so they
// cannot drift from the code:
//   docs/generated/api-reference.md   every route with the session and permissions it needs,
//                                     and the role/permission matrix
//   docs/generated/data-dictionary.md every table: columns, keys, constraints, indexes, triggers
//   docs/generated/erd.md             the ERD as Mermaid diagrams, one per module
//
//   pnpm --filter ./apps/api docs:reference
//
// Reads the migrated test database (TEST_DATABASE_URL, migrated by every test run). Only
// catalog queries are made; no data is read.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { PERMISSIONS, ROLE_DEFINITIONS, ROLE_PERMISSIONS } from "@bcis/shared";
import { buildApp, type RouteInfo } from "../src/app";
import { createDb } from "../src/db/client";
import { testConfig } from "../src/test/helpers";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoDir, "docs/generated");

/** Modules of the data model, in reading order, with what each table holds. */
const MODULES: Array<{ name: string; about: string; tables: Record<string, string> }> = [
  {
    name: "Access and audit",
    about: "Who can sign in, what each role may do, live sessions, and the append-only audit trail.",
    tables: {
      users: "Staff accounts. Password stored as an argon2id hash; failed attempts and lockout tracked here. Deactivated, never deleted.",
      roles: "The seven roles (owner, administrator, cashier, collection supervisor, auditor, technician, viewer).",
      permissions: "Permission codes checked by the API on every request.",
      role_permissions: "Which permissions each role grants.",
      user_roles: "Which roles each user holds.",
      sessions: "Signed-in sessions. Only a SHA-256 hash of the session token is stored.",
      audit_logs: "Every change: actor, action, record, reason, old and new values. Append-only (database trigger).",
    },
  },
  {
    name: "Subscribers and services",
    about: "Customers, their addresses and contacts, the plans offered, and each service account with its history.",
    tables: {
      subscribers: "Customer accounts (BCIS- numbers). Status active, inactive, terminated or archived; never deleted.",
      subscriber_addresses: "Addresses of a subscriber; at most one is primary. Deactivated, never deleted.",
      subscriber_contacts: "Phone numbers and emails; at most one is primary. Searchable by digits (trigram index).",
      service_types: "Internet, cable, combo.",
      service_plans: "Plans with price, speed or channel count and installation fee. Deactivated, never deleted.",
      service_accounts: "One connection (SVC- number): plan, installation address, current rate, status and billing start.",
      service_events: "History of each service: activation, plan and rate changes, suspensions, reconnections. Append-only.",
    },
  },
  {
    name: "Billing and ledger",
    about: "Monthly billing runs, invoices and their lines, adjustments, and the subscriber ledger that every balance comes from.",
    tables: {
      billing_cycles: "One row per billed month; locked while a run generates or finalizes.",
      invoices: "One per service account per month (INV- numbers). Draft until finalized; paid and adjusted amounts kept on the row; voided, never deleted.",
      invoice_items: "Invoice lines: subscription, installation fee, reconnection fee.",
      adjustments: "Credits and debits on an invoice (ADJ- numbers) with category and reason. Posted, never edited.",
      ledger_entries: "Every debit and credit of a subscriber: invoices, payments, reversals, adjustments, voids. Append-only; the balance is their sum.",
      document_sequences: "Counters for invoice, receipt, adjustment, batch and backup numbers, taken under a row lock so numbers never repeat or skip.",
    },
  },
  {
    name: "Payments and GCash",
    about: "Money received, how it was applied to invoices, reversals, and GCash submissions with their proof images.",
    tables: {
      payments: "Every payment (RCPT- numbers): method, amount, allocated amount, status posted or reversed.",
      payment_allocations: "How much of a payment went to which invoice, oldest first unless chosen by hand. Append-only.",
      payment_reversals: "The reversal of a payment, with who and why. The original stays. Append-only.",
      gcash_submissions: "GCash payments reported by customers: reference (unique), sender, amount, status pending, verified or rejected.",
      payment_proofs: "Proof images of a GCash submission or a payment: stored name, type, size (5 MB max) and SHA-256. Append-only.",
    },
  },
  {
    name: "Collections",
    about: "Collection areas, collectors, their batches (route sheets), field collections and cash remittances.",
    tables: {
      collection_areas: "Areas and routes subscribers belong to.",
      collectors: "Field collectors; may be linked to a user account.",
      collector_assignments: "Which collector serves a subscriber, with effective dates; at most one open assignment per subscriber.",
      collection_batches: "A collector's outing (CB- numbers): route sheet snapshot, lifecycle from open to closed, reconciliation figures and variance reason.",
      batch_accounts: "The subscribers on a batch with the balance they owed when it was built.",
      collector_remittances: "Cash handed over by the collector; voided with a reason, never deleted.",
    },
  },
  {
    name: "Service control",
    about: "Suspensions for non-payment and the reconnection workflow, including the reconnection fee.",
    tables: {
      suspension_records: "Each suspension: date, reason, who approved it.",
      reconnection_records: "Reconnection requests: technician, completion, fee or fee waiver.",
    },
  },
  {
    name: "Settings, backups and integrity",
    about: "Business settings, the backup history and the results of integrity checks.",
    tables: {
      application_settings: "Business settings as key/value pairs (grace period, suspension threshold).",
      backup_history: "Every backup (BK- numbers): kind, files, checksums, verification. Protected by a trigger: only verification fields change after completion.",
      integrity_checks: "Results of integrity checks (live, test restore, after restore). Append-only.",
    },
  },
];

/* ------------------------------ API reference ------------------------------ */

function access(route: RouteInfo): string {
  if (!route.authenticated) return "Public";
  if (route.permissions.length === 0) return "Signed in (own account)";
  return route.permissions
    .map((rule) => (rule.mode === "all" ? rule.codes.map((c) => `\`${c}\``).join(" + ") : `any of ${rule.codes.map((c) => `\`${c}\``).join(", ")}`))
    .join("; ");
}

function apiReference(routes: RouteInfo[]): string {
  const groups = new Map<string, RouteInfo[]>();
  for (const route of routes.toSorted((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const group = route.url.split("/")[1] ?? "";
    groups.set(group, [...(groups.get(group) ?? []), route]);
  }
  const roleCodes = ROLE_DEFINITIONS.map((r) => r.code);
  const lines = [
    "# API Reference",
    "",
    `Generated from the running route table: ${routes.length} routes. Every route except the public ones requires a session token (\`Authorization: Bearer …\`); the permissions listed are checked on the server on every request, against the database. Bodies, queries and path parameters are validated with the Zod schemas in \`@bcis/shared\`; errors are JSON \`{ error, message }\`, validation errors \`{ error: "VALIDATION", issues }\`.`,
    "",
  ];
  for (const [group, list] of groups) {
    lines.push(`## /${group}`, "", "| Method | Path | Access |", "|---|---|---|");
    for (const route of list) lines.push(`| ${route.method} | \`${route.url}\` | ${access(route)} |`);
    lines.push("");
  }
  lines.push(
    "## Roles and permissions",
    "",
    "Which permissions each role grants (seeded by `db:seed`, `apps/api/src/db/rbac.ts`).",
    "",
    `| Permission | ${ROLE_DEFINITIONS.map((r) => r.name).join(" | ")} |`,
    `|---|${roleCodes.map(() => ":-:").join("|")}|`,
    ...PERMISSIONS.map(
      (code) => `| \`${code}\` | ${roleCodes.map((role) => (ROLE_PERMISSIONS[role].includes(code) ? "✓" : "")).join(" | ")} |`,
    ),
    "",
  );
  return lines.join("\n");
}

/* ------------------------------ Data dictionary ------------------------------ */

interface Column {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  default: string | null;
}
/** A column as information_schema returns it ("YES"/"NO" for nullable). */
interface ColumnRow extends Record<string, unknown> {
  table: string;
  column: string;
  type: string;
  nullable: string;
  default: string | null;
}
interface ForeignKey extends Record<string, unknown> {
  table: string;
  column: string;
  ref_table: string;
  ref_column: string;
}

const shortType = (t: string) =>
  t
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp")
    .replace("character varying", "varchar")
    .replace("double precision", "double");

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (the migrated test database is read for the schema)");
  const { db, pool } = createDb(url);
  try {
    const app = buildApp(testConfig({ DATABASE_URL: url }), { db, pool });
    await app.ready();
    const routes = [...app.routeTable];
    await app.close();

    const columns = (
      await db.execute<ColumnRow>(sql`
        SELECT table_name AS table, column_name AS column,
               CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END AS type,
               is_nullable AS nullable, column_default AS default
        FROM information_schema.columns WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`)
    ).rows.map((c): Column => ({ ...c, nullable: c.nullable === "YES" }));
    const primary = (
      await db.execute<{ table: string; column: string }>(sql`
        SELECT tc.table_name AS table, kcu.column_name AS column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`)
    ).rows;
    const foreign = (
      await db.execute<ForeignKey>(sql`
        SELECT cl.relname AS table, att.attname AS column, rcl.relname AS ref_table, ratt.attname AS ref_column
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_class rcl ON rcl.oid = con.confrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, refcol)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.col
        JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = k.refcol
        WHERE con.contype = 'f'
        ORDER BY 1, 2`)
    ).rows;
    const constraints = (
      await db.execute<{ table: string; name: string; kind: string; definition: string }>(sql`
        SELECT cl.relname AS table, con.conname AS name, con.contype AS kind, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
        WHERE con.contype IN ('u', 'c')
        ORDER BY 1, 2`)
    ).rows;
    const indexes = (
      await db.execute<{ table: string; name: string; definition: string }>(sql`
        SELECT tablename AS table, indexname AS name, indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'
          AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype = 'u')
        ORDER BY 1, 2`)
    ).rows;
    const triggers = (
      await db.execute<{ table: string; name: string; timing: string; fn: string }>(sql`
        SELECT cl.relname AS table, t.tgname AS name,
               CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing, p.proname AS fn
        FROM pg_trigger t
        JOIN pg_class cl ON cl.oid = t.tgrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
        ORDER BY 1, 2`)
    ).rows;

    const allTables = [...new Set(columns.map((c) => c.table))];
    const documented = MODULES.flatMap((m) => Object.keys(m.tables));
    const missing = allTables.filter((t) => !documented.includes(t));
    if (missing.length > 0) throw new Error(`Tables without a module and description: ${missing.join(", ")}`);

    const isPk = (t: string, c: string) => primary.some((p) => p.table === t && p.column === c);
    const fkOf = (t: string, c: string) => foreign.find((f) => f.table === t && f.column === c);

    /* Data dictionary */
    const dd = [
      "# Data Dictionary",
      "",
      `Generated from the migrated database: ${allTables.length} tables in ${MODULES.length} modules. Money is stored as integer centavos (\`*_centavos\`); dates as \`date\`, moments as \`timestamptz\`. Checks and triggers listed here are enforced by PostgreSQL itself, whatever the application does.`,
      "",
    ];
    for (const module of MODULES) {
      dd.push(`## ${module.name}`, "", module.about, "");
      for (const [table, about] of Object.entries(module.tables)) {
        dd.push(`### ${table}`, "", about, "", "| Column | Type | Null | Default | Key |", "|---|---|---|---|---|");
        for (const c of columns.filter((x) => x.table === table)) {
          const fk = fkOf(table, c.column);
          const key = [isPk(table, c.column) ? "PK" : "", fk ? `FK → ${fk.ref_table}.${fk.ref_column}` : ""].filter(Boolean).join(", ");
          const def = c.default ? `\`${c.default.replaceAll("|", "\\|").slice(0, 60)}\`` : "";
          dd.push(`| ${c.column} | ${shortType(c.type)} | ${c.nullable ? "yes" : "no"} | ${def} | ${key} |`);
        }
        const tableConstraints = constraints.filter((x) => x.table === table);
        const tableIndexes = indexes.filter((x) => x.table === table);
        const tableTriggers = triggers.filter((x) => x.table === table);
        if (tableConstraints.length + tableIndexes.length + tableTriggers.length > 0) dd.push("");
        for (const con of tableConstraints) {
          dd.push(`- ${con.kind === "u" ? "Unique" : "Check"} \`${con.name}\`: \`${con.definition}\``);
        }
        for (const idx of tableIndexes) {
          const unique = idx.definition.startsWith("CREATE UNIQUE") ? "Unique index" : "Index";
          const on = idx.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON public\.\S+ USING \w+ /, "");
          dd.push(`- ${unique} \`${idx.name}\`: \`${on}\``);
        }
        for (const trg of tableTriggers) dd.push(`- Trigger \`${trg.name}\` (${trg.timing}): \`${trg.fn}()\``);
        dd.push("");
      }
    }

    /* ERD: one Mermaid diagram per module. Columns shown: keys, money, numbers and statuses. */
    const shown = (t: string, c: string) =>
      isPk(t, c) || !!fkOf(t, c) || /(_centavos|_number|^status$|^code$|^kind$|_date$|^period_start$)/.test(c);
    const erd = [
      "# Entity-Relationship Diagram",
      "",
      "Generated from the migrated database. One diagram per module; tables from other modules appear without columns where they are referenced. Only keys, money, document numbers, statuses and key dates are drawn; every column is in the data dictionary. Most tables also record who created or changed a row (a foreign key to `users`); those links are drawn only in the first diagram, to keep the others readable.",
      "",
      "Notation: `||--o{` one to many; `|o--o{` the parent is optional (nullable foreign key).",
      "",
    ];
    for (const [n, module] of MODULES.entries()) {
      // Mermaid builds element ids from entity names; a table drawn in two diagrams on one page
      // would collide, so each diagram gets its own ids and shows the table name as the label.
      const id = (table: string) => `m${n}_${table}`;
      const own = Object.keys(module.tables);
      const links = foreign.filter(
        (f) => own.includes(f.table) && (module.name === "Access and audit" || f.ref_table !== "users"),
      );
      const others = [...new Set(links.map((f) => f.ref_table).filter((t) => !own.includes(t)))];
      // Each module on its own page, so a diagram can use the whole page.
      if (module !== MODULES[0]) erd.push('<div class="page-break"></div>', "");
      erd.push(`## ${module.name}`, "", module.about, "", "```mermaid", "erDiagram");
      for (const table of own) {
        erd.push(`  ${id(table)}["${table}"] {`);
        for (const c of columns.filter((x) => x.table === table && shown(table, x.column))) {
          const keys = [isPk(table, c.column) ? "PK" : "", fkOf(table, c.column) ? "FK" : ""].filter(Boolean).join(",");
          erd.push(`    ${shortType(c.type).replaceAll(" ", "_")} ${c.column}${keys ? ` ${keys}` : ""}`);
        }
        erd.push("  }");
      }
      for (const other of others) erd.push(`  ${id(other)}["${other}"] {`, "  }");
      for (const f of links) {
        const col = columns.find((c) => c.table === f.table && c.column === f.column);
        erd.push(`  ${id(f.ref_table)} ${col?.nullable ? "|o--o{" : "||--o{"} ${id(f.table)} : "${f.column}"`);
      }
      erd.push("```", "");
    }

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "api-reference.md"), apiReference(routes));
    await writeFile(path.join(outDir, "data-dictionary.md"), dd.join("\n"));
    await writeFile(path.join(outDir, "erd.md"), erd.join("\n"));
    console.log(`Wrote docs/generated: ${routes.length} routes, ${allTables.length} tables, ${foreign.length} foreign keys.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
