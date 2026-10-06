import { eq, sql } from "drizzle-orm";
import type { PermissionCode } from "@bcis/shared";
import type { Db } from "../db/client";
import { permissions, rolePermissions, userRoles, users } from "../db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createSession } from "./session";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    public readonly code: "INVALID_CREDENTIALS" | "ACCOUNT_LOCKED",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Verified against when the username doesn't exist, so "unknown user"
// takes about as long as "wrong password" and can't be told apart by timing.
const dummyHash = hashPassword("timing-equalizer-password");

export async function loadPermissions(
  db: Db,
  userId: string,
): Promise<PermissionCode[]> {
  const rows = await db
    .selectDistinct({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.code as PermissionCode);
}

export interface LoginResult {
  token: string;
  user: { id: string; username: string; fullName: string };
  permissions: PermissionCode[];
}

export async function login(
  db: Db,
  usernameInput: string,
  password: string,
): Promise<LoginResult> {
  const invalid = () =>
    new AuthError("INVALID_CREDENTIALS", 401, "Invalid username or password.");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, usernameInput.trim().toLowerCase()))
    .limit(1);

  if (!user) {
    await verifyPassword(await dummyHash, password);
    throw invalid();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthError(
      "ACCOUNT_LOCKED",
      423,
      "Too many failed attempts. Try again in a few minutes.",
    );
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);

  if (!passwordOk || !user.isActive) {
    if (user.isActive) {
      const [updated] = await db
        .update(users)
        .set({
          failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))
        .returning({ attempts: users.failedLoginAttempts });

      if (updated && updated.attempts >= MAX_FAILED_ATTEMPTS) {
        await db
          .update(users)
          .set({
            lockedUntil: new Date(Date.now() + LOCKOUT_MS),
            failedLoginAttempts: 0,
          })
          .where(eq(users.id, user.id));
      }
    }
    throw invalid();
  }

  await db
    .update(users)
    .set({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    token: await createSession(db, user.id),
    user: { id: user.id, username: user.username, fullName: user.fullName },
    permissions: await loadPermissions(db, user.id),
  };
}