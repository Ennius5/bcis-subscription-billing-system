import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { registerAuthRoutes } from "./auth/routes";


export interface AppDeps {
  pool?: Pool;
  db?: Db;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  app.decorateRequest("auth", null);

  app.get("/health", async () => ({
    status: "ok",
    service: "bcis-api",
    time: new Date().toISOString(),
  }));

  app.get("/health/db", async (_req, reply) => {
    if (!deps.pool) {
      return reply.code(503).send({ status: "unavailable" });
    }
    try {
      await deps.pool.query("SELECT 1");
      return { status: "ok", database: "connected" };
    } catch (err) {
      app.log.error(err, "database health check failed");
      return reply.code(503).send({ status: "error", database: "unreachable" });
    }
  });

    if (deps.db) registerAuthRoutes(app, deps.db);
    
  return app;
}