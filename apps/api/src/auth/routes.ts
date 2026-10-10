import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { passwordChangeSchema } from "@bcis/shared";
import type { Db } from "../db/client";
import { sendUserError } from "../admin/routes";
import { changeOwnPassword } from "../admin/users";
import { sendValidationError } from "../http/errors";
import { createAuthenticate } from "./authenticate";
import { AuthError, login } from "./service";
import { revokeSession } from "./session";

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "VALIDATION", message: "Username and password are required." });
    }
    try {
      return await login(db, parsed.data.username, parsed.data.password);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get("/auth/me", { preHandler: authenticate }, async (request) => {
    const { userId, username, fullName, mustChangePassword, permissions } = request.auth!;
    return { user: { id: userId, username, fullName, mustChangePassword }, permissions };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (request) => {
    await revokeSession(db, request.auth!.sessionId);
    return { status: "signed out" };
  });

  // Any signed-in user, no permission needed: it only ever touches their own account.
  app.post("/auth/password", { preHandler: authenticate }, async (request, reply) => {
    const body = passwordChangeSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      await changeOwnPassword(db, request.auth!.userId, request.auth!.sessionId, body.data);
      return { status: "password changed" };
    } catch (err) {
      return sendUserError(reply, err);
    }
  });
}
