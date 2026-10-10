import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db/client";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const app = buildApp(config, { db, pool });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  // A bug outside any request (a timer, a stray promise) must not leave the server half alive.
  // Log it, then stop; the Task Scheduler restart setting brings the server back (deployment guide).
  // Every open transaction is rolled back by PostgreSQL when the connection drops.
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (err) => {
      app.log.fatal({ err }, `${event}: stopping the server`);
      process.exit(1);
    });
  }

  // Ctrl+C or a service stop: finish requests in flight, then close the pool.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }

  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
    app.log.info({ logDir: config.LOG_DIR }, "BCIS API started");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
