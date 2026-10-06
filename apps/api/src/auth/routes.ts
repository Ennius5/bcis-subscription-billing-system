import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client";
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
    const { userId, username, fullName, permissions } = request.auth!;
    return { user: { id: userId, username, fullName }, permissions };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (request) => {
    await revokeSession(db, request.auth!.sessionId);
    return { status: "signed out" };
  });
}