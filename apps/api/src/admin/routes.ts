import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  passwordResetSchema,
  userCreateSchema,
  userRolesChangeSchema,
  userStatusChangeSchema,
  userUnlockSchema,
  userUpdateSchema,
} from "@bcis/shared";
import type { Db } from "../db/client";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import { sendValidationError } from "../http/errors";
import {
  changeUserRoles,
  changeUserStatus,
  createUser,
  listUsers,
  resetPassword,
  unlockUser,
  updateUser,
  UserError,
} from "./users";

const idParams = z.object({ id: z.uuid() });

export function sendUserError(reply: FastifyReply, err: unknown) {
  if (err instanceof UserError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerAdminRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canManageUsers = { preHandler: [authenticate, requirePermission("user.manage")] };

  app.get("/admin/users", canManageUsers, async () => listUsers(db));

  app.post("/admin/users", canManageUsers, async (request, reply) => {
    const body = userCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return reply.code(201).send(await createUser(db, request.auth!.userId, body.data));
    } catch (err) {
      return sendUserError(reply, err);
    }
  });

  app.patch("/admin/users/:id", canManageUsers, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = userUpdateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await updateUser(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendUserError(reply, err);
    }
  });

  app.post("/admin/users/:id/roles", canManageUsers, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = userRolesChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeUserRoles(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendUserError(reply, err);
    }
  });

  app.post("/admin/users/:id/status", canManageUsers, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = userStatusChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await changeUserStatus(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendUserError(reply, err);
    }
  });

  app.post("/admin/users/:id/unlock", canManageUsers, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = userUnlockSchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await unlockUser(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendUserError(reply, err);
    }
  });

  app.post("/admin/users/:id/reset-password", canManageUsers, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = passwordResetSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await resetPassword(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendUserError(reply, err);
    }
  });
}
