import type { FastifyReply, FastifyRequest } from "fastify";
import type { PermissionCode } from "@bcis/shared";

/** What a permission guard checks: all of the codes, or any one of them. */
export interface GuardRule {
  mode: "all" | "any";
  codes: readonly PermissionCode[];
}

// Each guard remembers its rule, so the route table (and the generated API reference) can say
// which permissions every route needs without parsing the source.
const rules = new WeakMap<object, GuardRule>();

/** The rule behind a preHandler made by requirePermission/requireAnyPermission, if it is one. */
export function guardRule(handler: unknown): GuardRule | undefined {
  return typeof handler === "function" ? rules.get(handler) : undefined;
}

/** Use after `authenticate`. Rejects unless the user holds ALL listed permissions. */
export function requirePermission(...required: PermissionCode[]) {
  async function guard(
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
  }
  rules.set(guard, { mode: "all", codes: required });
  return guard;
}
/** Use after `authenticate`. Rejects unless the user holds AT LEAST ONE of the listed permissions. */
export function requireAnyPermission(...allowed: PermissionCode[]) {
  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const granted = request.auth?.permissions ?? [];
    if (!allowed.some((code) => granted.includes(code))) {
      return reply.code(403).send({
        error: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
      });
    }
  }
  rules.set(guard, { mode: "any", codes: allowed });
  return guard;
}
