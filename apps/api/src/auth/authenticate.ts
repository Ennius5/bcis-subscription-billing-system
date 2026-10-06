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
  permissions: PermissionCode[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

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

    request.auth = {
      userId: session.userId,
      username: session.username,
      fullName: session.fullName,
      sessionId: session.sessionId,
      permissions: await loadPermissions(db, session.userId),
    };
  };
}