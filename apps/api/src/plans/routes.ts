import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  planCreateSchema,
  planUpdateSchema,
  SERVICE_TYPE_CODES,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { createPlan, listPlans, PlanError, updatePlan } from "./service";

const listQuery = z.object({
  includeInactive: z.enum(["true", "false"]).optional(),
  serviceType: z.enum(SERVICE_TYPE_CODES).optional(),
});

const idParams = z.object({ id: z.uuid() });

function sendPlanError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlanError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerPlanRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);

  app.get(
    "/plans",
    { preHandler: [authenticate, requirePermission("plan.view")] },
    async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error);
      return listPlans(db, {
        includeInactive: query.data.includeInactive === "true",
        ...(query.data.serviceType ? { serviceType: query.data.serviceType } : {}),
      });
    },
  );

  app.post(
    "/plans",
    { preHandler: [authenticate, requirePermission("plan.manage")] },
    async (request, reply) => {
      const body = planCreateSchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error);
      try {
        const plan = await createPlan(db, request.auth!.userId, body.data);
        return reply.code(201).send(plan);
      } catch (err) {
        return sendPlanError(reply, err);
      }
    },
  );

  app.patch(
    "/plans/:id",
    { preHandler: [authenticate, requirePermission("plan.manage")] },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error);
      const body = planUpdateSchema.safeParse(request.body);
      if (!body.success) return sendValidationError(reply, body.error);
      try {
        return await updatePlan(db, request.auth!.userId, params.data.id, body.data);
      } catch (err) {
        return sendPlanError(reply, err);
      }
    },
  );
}