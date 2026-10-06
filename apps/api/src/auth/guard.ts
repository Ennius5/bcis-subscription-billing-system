import type { FastifyReply, FastifyRequest } from "fastify";
import type { PermissionCode } from "@bcis/shared";

/** Use after `authenticate`. Rejects unless the user holds ALL listed permissions. */
export function requirePermission(...required: PermissionCode[]) {
  return async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const granted = request.auth?.permissions ?? [];
    if (!required.every((code) => granted.includes(code))) {
      return reply.code(403).send({
        error: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
      });
    }
  };
}