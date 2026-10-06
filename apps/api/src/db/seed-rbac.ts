import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { loadConfig } from "../config";
import { createDb } from "./client";
import { syncRolesAndPermissions } from "./rbac";
import { userRoles, users } from "./schema";

async function main() {
  const config = loadConfig();
  const username = (process.env.SEED_ADMIN_USERNAME ?? "admin").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("SEED_ADMIN_PASSWORD must be set and at least 10 characters");
  }

  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const roleIds = await syncRolesAndPermissions(db);
    const ownerRoleId = roleIds.get("owner");
    if (!ownerRoleId) throw new Error("Owner role missing");

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      console.log(`User "${username}" already exists, leaving it unchanged.`);
    } else {
      const passwordHash = await hashPassword(password);
      await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ username, fullName: "System Owner", passwordHash })
          .returning({ id: users.id });
        if (!created) throw new Error("Failed to create owner user");
        await tx.insert(userRoles).values({ userId: created.id, roleId: ownerRoleId });
      });
      console.log(`Created owner account "${username}".`);
    }
    console.log("RBAC seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});