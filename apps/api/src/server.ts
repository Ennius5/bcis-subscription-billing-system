import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db/client";

async function main() {
  const config = loadConfig();
  const { pool } = createDb(config.DATABASE_URL);
  const app = buildApp(config, { pool });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();