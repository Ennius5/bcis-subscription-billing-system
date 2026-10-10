import type { FastifyInstance } from "fastify";
import { auditLogQuerySchema } from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { getAuditFilterOptions, listAuditLogs } from "./log";

/** Administration > Audit Log (audit.view). Read-only: there is no route that changes audit rows. */
export function registerAuditRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("audit.view")] };

  app.get("/audit-logs", canView, async (request, reply) => {
    const query = auditLogQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listAuditLogs(db, query.data);
  });

  app.get("/audit-logs/filter-options", canView, async () => getAuditFilterOptions(db));
}
