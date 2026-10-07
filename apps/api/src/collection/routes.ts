import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  areaCreateSchema,
  areaUpdateSchema,
  collectorCreateSchema,
  collectorUpdateSchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import {
  CollectionError,
  createArea,
  createCollector,
  listAreas,
  listCollectors,
  updateArea,
  updateCollector,
} from "./service";

const listQuery = z.object({
  includeInactive: z.enum(["true", "false"]).optional(),
});

const idParams = z.object({ id: z.uuid() });

function sendCollectionError(reply: FastifyReply, err: unknown) {
  if (err instanceof CollectionError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerCollectionRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("collection.view")] };
  const canManage = { preHandler: [authenticate, requirePermission("collection.manage")] };

  /* ------------------------------ Areas ------------------------------ */

  app.get("/collection-areas", canView, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listAreas(db, { includeInactive: query.data.includeInactive === "true" });
  });

  app.post("/collection-areas", canManage, async (request, reply) => {
    const body = areaCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const area = await createArea(db, request.auth!.userId, body.data);
      return reply.code(201).send(area);
    } catch (err) {
      return sendCollectionError(reply, err);
    }
  });

  app.patch("/collection-areas/:id", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = areaUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateArea(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendCollectionError(reply, err);
    }
  });

  /* ---------------------------- Collectors ---------------------------- */

  app.get("/collectors", canView, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listCollectors(db, { includeInactive: query.data.includeInactive === "true" });
  });

  app.post("/collectors", canManage, async (request, reply) => {
    const body = collectorCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const collector = await createCollector(db, request.auth!.userId, body.data);
      return reply.code(201).send(collector);
    } catch (err) {
      return sendCollectionError(reply, err);
    }
  });

  app.patch("/collectors/:id", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = collectorUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateCollector(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendCollectionError(reply, err);
    }
  });
}