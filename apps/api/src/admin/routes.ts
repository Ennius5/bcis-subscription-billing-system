import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";

export function registerAdminRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);

  app.get(
    "/admin/users",
    { preHandler: [authenticate, requirePermission("user.manage")] },
    async () =>
      db
        .select({
          id: users.id,
          username: users.username,
          fullName: users.fullName,
          isActive: users.isActive,
          lastLoginAt: users.lastLoginAt,
          lockedUntil: users.lockedUntil,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(asc(users.username)),
  );

  // Placeholder so the permission check can be tested now.
  // The real implementation arrives in the backup phase.
  app.post(
    "/admin/backups",
    { preHandler: [authenticate, requirePermission("backup.create")] },
    async (_request, reply) =>
      reply.code(501).send({ error: "NOT_IMPLEMENTED", message: "Backups are not implemented yet." }),
  );
}