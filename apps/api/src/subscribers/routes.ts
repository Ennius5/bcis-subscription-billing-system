import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  addressCreateSchema,
  addressUpdateSchema,
  contactInputSchema,
  contactUpdateSchema,
  globalSearchQuerySchema,
  subscriberAssignmentSchema,
  subscriberCreateSchema,
  subscriberListQuerySchema,
  subscriberStatusChangeSchema,
  subscriberUpdateSchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { globalSearch } from "./search";
import {
  addSubscriberAddress,
  addSubscriberContact,
  changeSubscriberAssignment,
  changeSubscriberStatus,
  createSubscriber,
  getSubscriber,
  listSubscriberHistory,
  listSubscribers,
  SubscriberError,
  updateSubscriber,
  updateSubscriberAddress,
  updateSubscriberContact,
} from "./service";

const idParams = z.object({ id: z.uuid() });
const addressParams = z.object({ id: z.uuid(), addressId: z.uuid() });
const contactParams = z.object({ id: z.uuid(), contactId: z.uuid() });

function sendSubscriberError(reply: FastifyReply, err: unknown) {
  if (err instanceof SubscriberError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerSubscriberRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("subscriber.view")] };
  const canManage = { preHandler: [authenticate, requirePermission("subscriber.manage")] };

  /* --------------------------- Global search --------------------------- */

  // Cashiers search too (spec 3.1), so this needs only subscriber.view.
  app.get("/search", canView, async (request, reply) => {
    const query = globalSearchQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return globalSearch(db, query.data);
  });

  /* ---------------------------- Subscribers ---------------------------- */

  app.get("/subscribers", canView, async (request, reply) => {
    const query = subscriberListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listSubscribers(db, query.data);
  });

  app.get("/subscribers/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getSubscriber(db, params.data.id);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.get("/subscribers/:id/history", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await listSubscriberHistory(db, params.data.id);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.post("/subscribers", canManage, async (request, reply) => {
    const body = subscriberCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const subscriber = await createSubscriber(db, request.auth!.userId, body.data);
      return reply.code(201).send(subscriber);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.patch("/subscribers/:id", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = subscriberUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateSubscriber(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.post("/subscribers/:id/status", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = subscriberStatusChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeSubscriberStatus(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.post("/subscribers/:id/assignment", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = subscriberAssignmentSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeSubscriberAssignment(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  /* ----------------------------- Addresses ----------------------------- */

  app.post("/subscribers/:id/addresses", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = addressCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const subscriber = await addSubscriberAddress(db, request.auth!.userId, params.data.id, body.data);
      return reply.code(201).send(subscriber);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.patch("/subscribers/:id/addresses/:addressId", canManage, async (request, reply) => {
    const params = addressParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = addressUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateSubscriberAddress(
        db,
        request.auth!.userId,
        params.data.id,
        params.data.addressId,
        body.data,
      );
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  /* ----------------------------- Contacts ----------------------------- */

  app.post("/subscribers/:id/contacts", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = contactInputSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const subscriber = await addSubscriberContact(db, request.auth!.userId, params.data.id, body.data);
      return reply.code(201).send(subscriber);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.patch("/subscribers/:id/contacts/:contactId", canManage, async (request, reply) => {
    const params = contactParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = contactUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateSubscriberContact(
        db,
        request.auth!.userId,
        params.data.id,
        params.data.contactId,
        body.data,
      );
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });
}
