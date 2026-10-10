import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** database/migrations at the repo root: one place for the migrator, tests and the integrity check. */
export const MIGRATIONS_FOLDER = path.resolve(here, "../../../../database/migrations");

/** How many migrations this version of the code expects to be applied (drizzle's journal). */
export async function expectedMigrationCount(): Promise<number> {
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}
