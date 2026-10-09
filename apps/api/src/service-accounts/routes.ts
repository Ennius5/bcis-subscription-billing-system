import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  serviceAccountCreateSchema,
  serviceAccountListQuerySchema,
  serviceAccountUpdateSchema,
  serviceCollectorChangeSchema,
  servicePlanChangeSchema,
  serviceRateChangeSchema,
  serviceStatusChangeSchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import {
  changeServiceCollector,
  changeServicePlan,
  changeServiceRate,
  changeServiceStatus,
  createServiceAccount,
  getServiceAccount,
  listServiceAccounts,
  ServiceAccountError,
  updateServiceAccount,
} from "./service";

const idParams = z.object({ id: z.uuid() });

function sendServiceAccountError(reply: FastifyReply, err: unknown) {
  if (err instanceof ServiceAccountError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerServiceAccountRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("service.view")] };
  // Status changes (activation, suspension, reconnection) also need service.manage for now;
  // Phase 7 may move suspension work to suspension.manage.
  const canManage = { preHandler: [authenticate, requirePermission("service.manage")] };

  app.get("/service-accounts", canView, async (request, reply) => {
    const query = serviceAccountListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listServiceAccounts(db, query.data);
  });

  app.get("/service-accounts/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getServiceAccount(db, params.data.id);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  // Created under its subscriber, which owns the installation address.
  app.post("/subscribers/:id/service-accounts", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceAccountCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const account = await createServiceAccount(db, request.auth!.userId, params.data.id, body.data);
      return reply.code(201).send(account);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  app.patch("/service-accounts/:id", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceAccountUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateServiceAccount(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  app.post("/service-accounts/:id/status", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceStatusChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeServiceStatus(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  app.post("/service-accounts/:id/rate", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceRateChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeServiceRate(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  app.post("/service-accounts/:id/plan", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = servicePlanChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeServicePlan(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });

  app.post("/service-accounts/:id/collector", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = serviceCollectorChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeServiceCollector(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendServiceAccountError(reply, err);
    }
  });
}
