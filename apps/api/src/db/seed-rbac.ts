import { eq } from "drizzle-orm";
import { PERMISSIONS, ROLE_DEFINITIONS, ROLE_PERMISSIONS } from "@bcis/shared";
import { hashPassword } from "../auth/password";
import { loadConfig } from "../config";
import { createDb } from "./client";
import { permissions, rolePermissions, roles, userRoles, users } from "./schema";

async function main() {
  const config = loadConfig();
  const username = (process.env.SEED_ADMIN_USERNAME ?? "admin").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("SEED_ADMIN_PASSWORD must be set and at least 10 characters");
  }

  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(permissions)
        .values(PERMISSIONS.map((code) => ({ code, description: code })))
        .onConflictDoNothing({ target: permissions.code });

      await tx
        .insert(roles)
        .values(ROLE_DEFINITIONS.map((r) => ({ code: r.code, name: r.name, description: r.description })))
        .onConflictDoNothing({ target: roles.code });

      const permissionId = new Map((await tx.select().from(permissions)).map((p) => [p.code, p.id]));
      const roleId = new Map((await tx.select().from(roles)).map((r) => [r.code, r.id]));

      const links: { roleId: string; permissionId: string }[] = [];
      for (const role of ROLE_DEFINITIONS) {
        for (const code of ROLE_PERMISSIONS[role.code]) {
          const rId = roleId.get(role.code);
          const pId = permissionId.get(code);
          if (!rId || !pId) throw new Error(`Missing role or permission: ${role.code}/${code}`);
          links.push({ roleId: rId, permissionId: pId });
        }
      }
      await tx.insert(rolePermissions).values(links).onConflictDoNothing();

      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existing.length > 0) {
        console.log(`User "${username}" already exists, leaving it unchanged.`);
        return;
      }

      const ownerRoleId = roleId.get("owner");
      if (!ownerRoleId) throw new Error("Owner role missing");

      const [created] = await tx
        .insert(users)
        .values({
          username,
          fullName: "System Owner",
          passwordHash: await hashPassword(password),
        })
        .returning({ id: users.id });
      if (!created) throw new Error("Failed to create owner user");

      await tx.insert(userRoles).values({ userId: created.id, roleId: ownerRoleId });
      console.log(`Created owner account "${username}".`);
    });
    console.log("RBAC seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});