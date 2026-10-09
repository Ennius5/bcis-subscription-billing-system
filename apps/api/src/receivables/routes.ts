import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  agingQuerySchema,
  receivableListQuerySchema,
  receivableSettingsUpdateSchema,
  reconnectionAssignSchema,
  reconnectionCancelSchema,
  reconnectionCompleteSchema,
  reconnectionListQuerySchema,
  reconnectionRequestSchema,
  serviceSuspendSchema,
  suspensionCandidateQuerySchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requireAnyPermission, requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { ServiceAccountError } from "../service-accounts/service";
import {
  getAgingReport,
  getReceivableFilterOptions,
  getReceivableSettings,
  listReceivables,
  listSuspensionCandidates,
  updateReceivableSettings,
} from "./service";
import {
  ServiceControlError,
  assignReconnection,
  cancelReconnection,
  completeReconnection,
  getReconnection,
  getServiceControlHistory,
  listReconnections,
  listTechnicians,
  requestReconnection,
  suspendService,
} from "./suspensions";

const idParams = z.object({ id: z.uuid() });

function sendControlError(reply: FastifyReply, err: unknown) {
  if (err instanceof ServiceControlError || err instanceof ServiceAccountError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Receivables, suspension and reconnection (Phase 7). Lists and aging need receivable.view;
 * the candidate list and every suspension/reconnection step need suspension.manage (which
 * technicians have); the service's control history is part of the service (service.view);
 * the grace period and threshold need settings.manage.
 */
export function registerReceivableRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("receivable.view")] };
  const canControl = { preHandler: [authenticate, requirePermission("suspension.manage")] };
  const canViewService = { preHandler: [authenticate, requirePermission("service.view")] };
  const canSettings = { preHandler: [authenticate, requirePermission("settings.manage")] };
  // The lists (receivable.view) and the candidate screen (suspension.manage) share the filters.
  const canFilter = { preHandler: [authenticate, requireAnyPermission("receivable.view", "suspension.manage")] };

  /* ----------------------------- Receivables ----------------------------- */

  app.get("/receivables", canView, async (request, reply) => {
    const query = receivableListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listReceivables(db, query.data);
  });

  app.get("/receivables/filter-options", canFilter, async () => getReceivableFilterOptions(db));

  app.get("/receivables/aging", canView, async (request, reply) => {
    const query = agingQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getAgingReport(db, query.data);
  });

  app.get("/receivables/suspension-candidates", canControl, async (request, reply) => {
    const query = suspensionCandidateQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listSuspensionCandidates(db, query.data);
  });

  /* ------------------------------ Settings ------------------------------ */

  app.get("/settings/receivables", canSettings, async () => getReceivableSettings(db));

  app.patch("/settings/receivables", canSettings, async (request, reply) => {
    const body = receivableSettingsUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    return updateReceivableSettings(db, request.auth!.userId, body.data);
  });

  /* ------------------------------ Suspension ------------------------------ */

  app.post("/service-accounts/:id/suspend", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceSuspendSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await suspendService(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.get("/service-accounts/:id/service-control", canViewService, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    return getServiceControlHistory(db, params.data.id);
  });

  /* ----------------------------- Reconnection ----------------------------- */

  app.post("/service-accounts/:id/reconnections", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = reconnectionRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return reply.code(201).send(await requestReconnection(db, request.auth!.userId, params.data.id, body.data));
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.get("/reconnections", canControl, async (request, reply) => {
    const query = reconnectionListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listReconnections(db, query.data);
  });

  app.get("/reconnections/:id", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getReconnection(db, params.data.id);
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.post("/reconnections/:id/assign", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = reconnectionAssignSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await assignReconnection(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.post("/reconnections/:id/complete", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = reconnectionCompleteSchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await completeReconnection(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.post("/reconnections/:id/cancel", canControl, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = reconnectionCancelSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await cancelReconnection(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendControlError(reply, err);
    }
  });

  app.get("/technicians", canControl, async () => listTechnicians(db));
}
