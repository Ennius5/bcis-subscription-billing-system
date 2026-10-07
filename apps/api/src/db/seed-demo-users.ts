import { eq } from "drizzle-orm";
import type { RoleCode } from "@bcis/shared";
import { hashPassword } from "../auth/password";
import { loadConfig } from "../config";
import { createDb } from "./client";
import { syncRolesAndPermissions } from "./rbac";
import { userRoles, users } from "./schema";

// Synthetic demo accounts only (spec section 8). Never use real people here.
const DEMO_USERS: ReadonlyArray<{ username: string; fullName: string; role: RoleCode }> = [
  { username: "demo_admin", fullName: "Demo Administrator", role: "administrator" },
  { username: "demo_cashier", fullName: "Demo Cashier", role: "cashier" },
  { username: "demo_supervisor", fullName: "Demo Collection Supervisor", role: "collection_supervisor" },
  { username: "demo_auditor", fullName: "Demo Auditor", role: "auditor" },
  { username: "demo_technician", fullName: "Demo Technician", role: "technician" },
  { username: "demo_viewer", fullName: "Demo Viewer", role: "viewer" },
];

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo users when NODE_ENV=production");
  }
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("SEED_DEMO_PASSWORD must be set and at least 10 characters");
  }

  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const roleIds = await syncRolesAndPermissions(db);
    const passwordHash = await hashPassword(password);

    for (const demo of DEMO_USERS) {
      const roleId = roleIds.get(demo.role);
      if (!roleId) throw new Error(`Role missing: ${demo.role}`);

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, demo.username))
        .limit(1);

      if (existing.length > 0) {
        console.log(`User "${demo.username}" already exists, leaving it unchanged.`);
        continue;
      }

      await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ username: demo.username, fullName: demo.fullName, passwordHash })
          .returning({ id: users.id });
        if (!created) throw new Error(`Failed to create ${demo.username}`);
        await tx.insert(userRoles).values({ userId: created.id, roleId });
      });
      console.log(`Created "${demo.username}" (${demo.role}).`);
    }
    console.log("Demo user seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});