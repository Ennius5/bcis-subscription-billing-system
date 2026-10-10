import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { registerAuthRoutes } from "./auth/routes";
import { registerAdminRoutes } from "./admin/routes";
import { registerAuditRoutes } from "./audit/routes";
import { registerPlanRoutes } from "./plans/routes";
import { registerBillingRoutes } from "./billing/routes";
import { registerBatchRoutes } from "./collection/batch-routes";
import { registerCollectionRoutes } from "./collection/routes";
import { registerSubscriberRoutes } from "./subscribers/routes";
import { registerServiceAccountRoutes } from "./service-accounts/routes";
import { registerPaymentRoutes } from "./payments/routes";
import { registerReceivableRoutes } from "./receivables/routes";
import { registerReportRoutes } from "./reports/routes";
import { ProofStore } from "./payments/proof-storage";

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

  if (deps.db) {
    registerAuthRoutes(app, deps.db);
    registerAdminRoutes(app, deps.db);
    registerAuditRoutes(app, deps.db);
    registerPlanRoutes(app, deps.db);
    registerCollectionRoutes(app, deps.db);
    registerBatchRoutes(app, deps.db);
    registerSubscriberRoutes(app, deps.db);
    registerBillingRoutes(app, deps.db);
    registerServiceAccountRoutes(app, deps.db);
    registerPaymentRoutes(app, deps.db, new ProofStore(config.PROOF_STORAGE_DIR));
    registerReceivableRoutes(app, deps.db);
    registerReportRoutes(app, deps.db);
  }

  return app;
}