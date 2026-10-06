import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { RoleCode } from "@bcis/shared";
import { hashPassword } from "../auth/password";
import { createDb, type Db } from "../db/client";
import { syncRolesAndPermissions } from "../db/rbac";
import { roles, userRoles, users } from "../db/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../../database/migrations");

export function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const dbName = new URL(url).pathname.replace("/", "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against "${dbName}": the database name must end with _test`);
  }
  return createDb(url);
}

/** Applies migrations, syncs roles/permissions and clears users and sessions. */
export async function prepareTestDatabase(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await syncRolesAndPermissions(db);
  await db.execute(sql`TRUNCATE sessions, user_roles, users CASCADE`);
}

export async function createTestUser(
  db: Db,
  username: string,
  password: string,
  roleCode: RoleCode,
): Promise<string> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, roleCode)).limit(1);
  if (!role) throw new Error(`Role not found: ${roleCode}`);

  const [user] = await db
    .insert(users)
    .values({ username, fullName: `Test ${roleCode}`, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");

  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });
  return user.id;
}