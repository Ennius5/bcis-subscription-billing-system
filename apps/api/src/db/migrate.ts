import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config";
import { createDb } from "./client";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../../database/migrations");

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});