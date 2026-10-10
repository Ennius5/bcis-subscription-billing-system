import type { FastifyReply, FastifyRequest } from "fastify";
import type { PermissionCode } from "@bcis/shared";
import type { Db } from "../db/client";
import { loadPermissions } from "./service";
import { findActiveSession } from "./session";

export interface AuthContext {
  userId: string;
  username: string;
  fullName: string;
  sessionId: string;
  mustChangePassword: boolean;
  permissions: PermissionCode[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

// While a password change is pending, only these routes answer: enough to see who is
// signed in, sign out, or set the new password. Everything else is refused server-side.
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = new Set(["/auth/me", "/auth/logout", "/auth/password"]);

export function createAuthenticate(db: Db) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const session = match?.[1] ? await findActiveSession(db, match[1]) : null;

    if (!session) {
      return reply
        .code(401)
        .send({ error: "UNAUTHENTICATED", message: "Please sign in again." });
    }

    if (
      session.mustChangePassword &&
      !ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.has(request.routeOptions.url ?? "")
    ) {
      return reply.code(403).send({
        error: "PASSWORD_CHANGE_REQUIRED",
        message: "Please choose a new password before continuing.",
      });
    }

    request.auth = {
      userId: session.userId,
      username: session.username,
      fullName: session.fullName,
      sessionId: session.sessionId,
      mustChangePassword: session.mustChangePassword,
      permissions: await loadPermissions(db, session.userId),
    };
  };
}