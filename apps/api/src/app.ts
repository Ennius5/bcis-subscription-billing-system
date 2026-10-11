import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
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
import { registerBackupRoutes } from "./backup/routes";
import { ProofStore } from "./payments/proof-storage";
import { registerErrorHandling } from "./http/error-handler";
import { loggerOptions, newRequestId } from "./http/logging";
import { MaintenanceGate } from "./http/maintenance";

declare module "fastify" {
  interface FastifyInstance {
    /** Locks everyone out during a restore; the backup routes use it. */
    maintenance: MaintenanceGate;
    /** Every route as registered, so the security test can walk all of them. */
    routeTable: { method: string; url: string }[];
  }
}

export interface AppDeps {
  pool?: Pool;
  db?: Db;
  /** Tests pass their own logger to read what was logged. */
  logger?: FastifyBaseLogger;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: loggerOptions(config) }),
    genReqId: newRequestId,
    // Fastify's default, written out: JSON bodies over 1 MB are refused (413).
    // Proof images have their own 5 MB limit on their one upload route.
    bodyLimit: 1024 * 1024,
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD") routeTable.push({ method, url: route.url });
    }
  });

  app.decorateRequest("auth", null);
  registerErrorHandling(app);
  const maintenance = new MaintenanceGate();
  maintenance.register(app);
  app.decorate("maintenance", maintenance);

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
    registerBackupRoutes(app, deps.db, config);
  }

  return app;
}