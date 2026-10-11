import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type {
  PasswordChangeInput,
  PasswordResetInput,
  RoleCode,
  UserCreateInput,
  UserRolesChangeInput,
  UserStatusChangeInput,
  UserUnlockInput,
  UserUpdateInput,
} from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import { hashPassword, verifyPassword } from "../auth/password";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from "../auth/service";
import { revokeUserSessions } from "../auth/session";
import type { Db } from "../db/client";
import { changedFields, type Tx, violatedConstraint } from "../db/query_helpers";
import { roles, userRoles, users } from "../db/schema";

export class UserError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "USERNAME_TAKEN"
      | "CANNOT_DEACTIVATE_SELF"
      | "CANNOT_REMOVE_OWN_OWNER_ROLE"
      | "LAST_OWNER"
      | "USE_CHANGE_PASSWORD"
      | "WRONG_PASSWORD"
      | "ACCOUNT_LOCKED",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the Users screen sees. Never the password hash. */
export interface UserRow {
  id: string;
  username: string;
  fullName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  /** True only while the lockout is still running. */
  isLocked: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: RoleCode[];
}

const OWNER: RoleCode = "owner";

async function fetchUsers(executor: Db | Tx, userId?: string): Promise<UserRow[]> {
  const rows = await executor
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      isLocked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)`,
      // "users"."id" is spelled out: Drizzle would print ${users.id} as a bare "id",
      // which inside this subquery means roles.id.
      roles: sql<RoleCode[]>`coalesce(
        (SELECT array_agg(r.code ORDER BY r.code)
           FROM ${userRoles} ur JOIN ${roles} r ON r.id = ur.role_id
          WHERE ur.user_id = "users"."id"),
        '{}')`,
    })
    .from(users)
    .where(userId ? eq(users.id, userId) : undefined)
    .orderBy(asc(users.username));
  return rows;
}

async function fetchUser(executor: Db | Tx, userId: string): Promise<UserRow> {
  const [row] = await fetchUsers(executor, userId);
  if (!row) throw new UserError("NOT_FOUND", 404, "User not found.");
  return row;
}

/** Locks the user row so two PCs cannot change the same account at once. */
async function lockUser(tx: Tx, userId: string) {
  const [row] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!row) throw new UserError("NOT_FOUND", 404, "User not found.");
  return row;
}

async function roleCodesOf(tx: Tx, userId: string): Promise<RoleCode[]> {
  const rows = await tx
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId))
    .orderBy(asc(roles.code));
  return rows.map((r) => r.code as RoleCode);
}

async function setRoles(tx: Tx, userId: string, codes: readonly RoleCode[]): Promise<void> {
  const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.code, [...codes]));
  // Roles come from the shared list, so a mismatch means `db:seed` was not run.
  if (found.length !== codes.length) throw new Error("Some roles are missing from the database");
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  await tx.insert(userRoles).values(found.map((r) => ({ userId, roleId: r.id })));
}

/**
 * Changes to roles and active state go through this lock, so two owners cannot
 * demote or deactivate each other at the same moment and leave nobody in charge.
 */
async function lockOwnership(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bcis.owners'))`);
}

async function otherActiveOwnerCount(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(DISTINCT ${users.id})::int` })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, OWNER), eq(users.isActive, true), ne(users.id, userId)));
  return row?.n ?? 0;
}

function sameRoles(a: readonly RoleCode[], b: readonly RoleCode[]): boolean {
  const sorted = b.toSorted();
  return a.length === b.length && a.toSorted().every((code, i) => code === sorted[i]);
}

/* ------------------------------ Read ------------------------------ */

export async function listUsers(db: Db): Promise<UserRow[]> {
  return fetchUsers(db);
}

/* ------------------------------ Create ------------------------------ */

export async function createUser(db: Db, actorUserId: string, input: UserCreateInput): Promise<UserRow> {
  const passwordHash = await hashPassword(input.temporaryPassword);
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          username: input.username,
          fullName: input.fullName,
          passwordHash,
          mustChangePassword: true,
        })
        .returning({ id: users.id });
      if (!created) throw new Error("Failed to create user");

      await setRoles(tx, created.id, input.roles);

      const user = await fetchUser(tx, created.id);
      await writeAudit(tx, {
        actorUserId,
        action: "user.create",
        entityType: "user",
        entityId: user.id,
        newValues: { username: user.username, fullName: user.fullName, roles: user.roles },
      });
      return user;
    });
  } catch (err) {
    if (violatedConstraint(err) === "users_username_unique") {
      throw new UserError("USERNAME_TAKEN", 409, `Username "${input.username}" is already in use.`);
    }
    throw err;
  }
}

/* ------------------------------ Update ------------------------------ */

export async function updateUser(
  db: Db,
  actorUserId: string,
  userId: string,
  input: UserUpdateInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const existing = await lockUser(tx, userId);
    const { reason, ...fields } = input;

    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchUser(tx, userId);

    await tx
      .update(users)
      .set({ ...newValues, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await writeAudit(tx, {
      actorUserId,
      action: "user.update",
      entityType: "user",
      entityId: userId,
      reason: reason ?? null,
      oldValues,
      newValues,
    });
    return fetchUser(tx, userId);
  });
}

export async function changeUserRoles(
  db: Db,
  actorUserId: string,
  userId: string,
  input: UserRolesChangeInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    await lockOwnership(tx);
    const existing = await lockUser(tx, userId);
    const before = await roleCodesOf(tx, userId);
    if (sameRoles(before, input.roles)) return fetchUser(tx, userId);

    const losesOwner = before.includes(OWNER) && !input.roles.includes(OWNER);
    if (losesOwner && userId === actorUserId) {
      throw new UserError(
        "CANNOT_REMOVE_OWN_OWNER_ROLE",
        409,
        "You cannot remove the owner role from your own account. Ask another owner.",
      );
    }
    if (losesOwner && existing.isActive && (await otherActiveOwnerCount(tx, userId)) === 0) {
      throw new UserError("LAST_OWNER", 409, "This is the only active owner. Make someone else an owner first.");
    }

    await setRoles(tx, userId, input.roles);
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, userId));

    const user = await fetchUser(tx, userId);
    await writeAudit(tx, {
      actorUserId,
      action: "user.roles_change",
      entityType: "user",
      entityId: userId,
      reason: input.reason ?? null,
      oldValues: { roles: before },
      newValues: { roles: user.roles },
    });
    return user;
  });
}

export async function changeUserStatus(
  db: Db,
  actorUserId: string,
  userId: string,
  input: UserStatusChangeInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    await lockOwnership(tx);
    const existing = await lockUser(tx, userId);
    if (existing.isActive === input.isActive) return fetchUser(tx, userId);

    if (!input.isActive) {
      if (userId === actorUserId) {
        throw new UserError("CANNOT_DEACTIVATE_SELF", 409, "You cannot deactivate your own account.");
      }
      const isOwner = (await roleCodesOf(tx, userId)).includes(OWNER);
      if (isOwner && (await otherActiveOwnerCount(tx, userId)) === 0) {
        throw new UserError("LAST_OWNER", 409, "This is the only active owner and cannot be deactivated.");
      }
    }

    await tx
      .update(users)
      .set({ isActive: input.isActive, updatedAt: new Date() })
      .where(eq(users.id, userId));
    // A deactivated user is signed out everywhere at once, not at their next idle timeout.
    if (!input.isActive) await revokeUserSessions(tx, userId);

    await writeAudit(tx, {
      actorUserId,
      action: "user.status_change",
      entityType: "user",
      entityId: userId,
      reason: input.reason,
      oldValues: { isActive: existing.isActive },
      newValues: { isActive: input.isActive },
    });
    return fetchUser(tx, userId);
  });
}

export async function unlockUser(
  db: Db,
  actorUserId: string,
  userId: string,
  input: UserUnlockInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const existing = await lockUser(tx, userId);
    // Same clock as the login check in auth/service.ts.
    const locked = existing.lockedUntil !== null && existing.lockedUntil > new Date();
    if (!locked && existing.failedLoginAttempts === 0) return fetchUser(tx, userId);

    await tx
      .update(users)
      .set({ lockedUntil: null, failedLoginAttempts: 0, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await writeAudit(tx, {
      actorUserId,
      action: "user.unlock",
      entityType: "user",
      entityId: userId,
      reason: input.reason ?? null,
      oldValues: { lockedUntil: existing.lockedUntil, failedLoginAttempts: existing.failedLoginAttempts },
      newValues: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    return fetchUser(tx, userId);
  });
}

/* ------------------------------ Passwords ------------------------------ */

/** An owner sets a temporary password; the user must replace it at their next sign-in. */
export async function resetPassword(
  db: Db,
  actorUserId: string,
  userId: string,
  input: PasswordResetInput,
): Promise<UserRow> {
  if (userId === actorUserId) {
    throw new UserError("USE_CHANGE_PASSWORD", 409, "Use Change my password for your own account.");
  }
  const passwordHash = await hashPassword(input.temporaryPassword);
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    // A reset also lifts a lockout: that is usually why the owner was asked.
    await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    await revokeUserSessions(tx, userId);

    // No password values in the audit row, not even hashes: only that it happened.
    await writeAudit(tx, {
      actorUserId,
      action: "user.password_reset",
      entityType: "user",
      entityId: userId,
      reason: input.reason ?? null,
      newValues: { mustChangePassword: true },
    });
    return fetchUser(tx, userId);
  });
}

/** Any signed-in user changing their own password. Other sessions of the user are ended. */
export async function changeOwnPassword(
  db: Db,
  userId: string,
  sessionId: string,
  input: PasswordChangeInput,
): Promise<void> {
  const [current] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!current) throw new UserError("NOT_FOUND", 404, "User not found.");
  if (!(await verifyPassword(current.passwordHash, input.currentPassword))) {
    // Same limit as signing in (auth/service.ts), so an unattended session cannot be used to
    // guess the password: the 5th wrong try locks the account and ends every session.
    const locked = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ attempts: users.failedLoginAttempts });
      if (!row || row.attempts < MAX_FAILED_ATTEMPTS) return false;
      await tx
        .update(users)
        .set({ lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLoginAttempts: 0 })
        .where(eq(users.id, userId));
      await revokeUserSessions(tx, userId);
      return true;
    });
    if (locked) {
      throw new UserError(
        "ACCOUNT_LOCKED",
        423,
        "Too many wrong passwords. You have been signed out; try again in 15 minutes or ask the owner to unlock you.",
      );
    }
    throw new UserError("WRONG_PASSWORD", 422, "The current password is not correct.");
  }

  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    const existing = await lockUser(tx, userId);
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await revokeUserSessions(tx, userId, sessionId);

    await writeAudit(tx, {
      actorUserId: userId,
      action: "user.password_change",
      entityType: "user",
      entityId: userId,
      ...(existing.mustChangePassword
        ? { oldValues: { mustChangePassword: true }, newValues: { mustChangePassword: false } }
        : {}),
    });
  });
}
