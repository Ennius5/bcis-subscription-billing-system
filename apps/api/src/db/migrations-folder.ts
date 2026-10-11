import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * database/migrations at the repo root: one place for the migrator, tests and the integrity
 * check. Found by walking up from this file, so it works from the TypeScript source
 * (apps/api/src/db) and from the production bundle (apps/api/dist) alike.
 * MIGRATIONS_DIR overrides it for unusual layouts.
 */
function findMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "database", "migrations");
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("database/migrations not found; set MIGRATIONS_DIR");
    dir = parent;
  }
}

export const MIGRATIONS_FOLDER = findMigrationsFolder();

/** How many migrations this version of the code expects to be applied (drizzle's journal). */
export async function expectedMigrationCount(): Promise<number> {
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}
