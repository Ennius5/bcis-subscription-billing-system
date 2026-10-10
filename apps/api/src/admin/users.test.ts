import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { auditLogs, users } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { changeUserRoles, changeUserStatus, UserError } from "./users";

const PASSWORD = "test-password-123";
const TEMP = "temporary-pass-1";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let ownerId: string;
let adminId: string;
let ownerHeaders: { authorization: string };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function login(username: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
}

async function tokenFor(username: string, password = PASSWORD): Promise<string> {
  const res = await login(username, password);
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function asOwner(method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: ownerHeaders, ...(payload === undefined ? {} : { payload }) });
}

async function auditFor(userId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, action)));
}

async function createViaApi(username: string, roles: string[] = ["cashier"]) {
  const res = await asOwner("POST", "/admin/users", {
    username,
    fullName: `Demo ${username}`,
    temporaryPassword: TEMP,
    roles,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; username: string; roles: string[]; mustChangePassword: boolean };
}

/** Creates a user and lets them pick their own password, so they can work normally. */
async function readyUser(username: string, roles: string[] = ["cashier"]) {
  const user = await createViaApi(username, roles);
  const token = await tokenFor(username, TEMP);
  const res = await app.inject({
    method: "POST",
    url: "/auth/password",
    headers: bearer(token),
    payload: { currentPassword: TEMP, newPassword: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return user;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  ownerId = await createTestUser(db, "owner1", PASSWORD, "owner");
  adminId = await createTestUser(db, "admin1", PASSWORD, "administrator");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");

  app = buildApp(testConfig(), { db, pool });
  await app.ready();
  ownerHeaders = bearer(await tokenFor("owner1"));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("user routes: authorization (AT-10)", () => {
  const writes: [string, string, unknown][] = [
    ["POST", "/admin/users", { username: "x-user", fullName: "X", temporaryPassword: TEMP, roles: ["viewer"] }],
    ["PATCH", "/admin/users/00000000-0000-4000-8000-000000000001", { fullName: "X" }],
    ["POST", "/admin/users/00000000-0000-4000-8000-000000000001/roles", { roles: ["viewer"] }],
    ["POST", "/admin/users/00000000-0000-4000-8000-000000000001/status", { isActive: false, reason: "test" }],
    ["POST", "/admin/users/00000000-0000-4000-8000-000000000001/unlock", {}],
    ["POST", "/admin/users/00000000-0000-4000-8000-000000000001/reset-password", { temporaryPassword: TEMP }],
  ];

  it("refuses cashiers and administrators on every user route, even called directly", async () => {
    for (const username of ["cashier1", "admin1"]) {
      const headers = bearer(await tokenFor(username));
      expect((await app.inject({ method: "GET", url: "/admin/users", headers })).statusCode).toBe(403);
      for (const [method, url, payload] of writes) {
        const res = await app.inject({ method: method as "POST", url, headers, payload: payload as object });
        expect(res.statusCode, `${username} ${method} ${url}`).toBe(403);
      }
    }
    expect((await db.select().from(users).where(eq(users.username, "x-user"))).length).toBe(0);
  });

  it("refuses requests without a token", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/users", payload: {} })).statusCode).toBe(401);
  });
});

describe("creating users", () => {
  it("creates a user with roles, a pending password change and an audit row without the password", async () => {
    const user = await createViaApi("maria.cashier", ["cashier", "viewer"]);
    expect(user.roles).toEqual(["cashier", "viewer"]);
    expect(user.mustChangePassword).toBe(true);

    const [row] = await auditFor(user.id, "user.create");
    expect(row?.actorUserId).toBe(ownerId);
    expect(row?.newValues).toEqual({ username: "maria.cashier", fullName: "Demo maria.cashier", roles: ["cashier", "viewer"] });
    expect(JSON.stringify(row)).not.toContain(TEMP);
  });

  it("lists users with roles and never returns password hashes", async () => {
    const res = await asOwner("GET", "/admin/users");
    expect(res.statusCode).toBe(200);
    const maria = res.json<{ username: string; roles: string[]; isLocked: boolean }[]>().find(
      (u) => u.username === "maria.cashier",
    );
    expect(maria?.roles).toEqual(["cashier", "viewer"]);
    expect(maria?.isLocked).toBe(false);
    expect(res.body).not.toContain("passwordHash");
    expect(res.body).not.toContain("argon2");
  });

  it("rejects a taken username without leaving anything behind", async () => {
    const res = await asOwner("POST", "/admin/users", {
      username: "MARIA.cashier",
      fullName: "Someone Else",
      temporaryPassword: TEMP,
      roles: ["viewer"],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("USERNAME_TAKEN");
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "user.create"))).length).toBe(1);
  });

  it("rejects a short password with a field issue", async () => {
    const res = await asOwner("POST", "/admin/users", {
      username: "short.pass",
      fullName: "Short Pass",
      temporaryPassword: "abc",
      roles: ["viewer"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("temporaryPassword");
  });
});

describe("pending password change", () => {
  it("blocks everything except me/logout/password until the user picks a password", async () => {
    await createViaApi("pending.user", ["cashier"]);
    const loginRes = await login("pending.user", TEMP);
    expect(loginRes.json().user.mustChangePassword).toBe(true);
    const headers = bearer(loginRes.json().token as string);

    const blocked = await app.inject({ method: "GET", url: "/subscribers", headers });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("PASSWORD_CHANGE_REQUIRED");

    const me = await app.inject({ method: "GET", url: "/auth/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(true);

    const wrong = await app.inject({
      method: "POST",
      url: "/auth/password",
      headers,
      payload: { currentPassword: "not-the-password", newPassword: PASSWORD },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toBe("WRONG_PASSWORD");

    const changed = await app.inject({
      method: "POST",
      url: "/auth/password",
      headers,
      payload: { currentPassword: TEMP, newPassword: PASSWORD },
    });
    expect(changed.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/subscribers", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).json().user.mustChangePassword).toBe(false);
  });

  it("changing your own password keeps this session and ends the others", async () => {
    const user = await readyUser("two.sessions");
    const first = bearer(await tokenFor("two.sessions"));
    const second = bearer(await tokenFor("two.sessions"));

    const res = await app.inject({
      method: "POST",
      url: "/auth/password",
      headers: first,
      payload: { currentPassword: PASSWORD, newPassword: "another-pass-456" },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: first })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: second })).statusCode).toBe(401);
    expect((await login("two.sessions", "another-pass-456")).statusCode).toBe(200);

    const rows = await auditFor(user.id, "user.password_change");
    expect(rows).toHaveLength(2); // the first-login change, then this one
    expect(rows.every((r) => r.actorUserId === user.id)).toBe(true);
  });
});

describe("editing users", () => {
  it("updates the name, audits only the change, and writes nothing on a no-op", async () => {
    const user = await createViaApi("rename.me");
    const res = await asOwner("PATCH", `/admin/users/${user.id}`, { fullName: "Renamed Person", reason: "Typo" });
    expect(res.statusCode).toBe(200);
    expect(res.json().fullName).toBe("Renamed Person");

    const again = await asOwner("PATCH", `/admin/users/${user.id}`, { fullName: "Renamed Person" });
    expect(again.statusCode).toBe(200);

    const rows = await auditFor(user.id, "user.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oldValues).toEqual({ fullName: "Demo rename.me" });
    expect(rows[0]?.newValues).toEqual({ fullName: "Renamed Person" });
    expect(rows[0]?.reason).toBe("Typo");
  });

  it("rejects an attempt to change the username", async () => {
    const user = await createViaApi("fixed.name");
    const res = await asOwner("PATCH", `/admin/users/${user.id}`, { username: "other.name" });
    expect(res.statusCode).toBe(400);
  });

  it("changes roles with an audit row; the same set is a no-op; permissions apply at once", async () => {
    const user = await readyUser("role.change", ["cashier"]);
    const headers = bearer(await tokenFor("role.change"));
    expect((await app.inject({ method: "GET", url: "/audit-logs", headers })).statusCode).toBe(403);

    const res = await asOwner("POST", `/admin/users/${user.id}/roles`, { roles: ["viewer", "auditor"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(["auditor", "viewer"]);
    expect((await app.inject({ method: "GET", url: "/audit-logs", headers })).statusCode).toBe(200);

    await asOwner("POST", `/admin/users/${user.id}/roles`, { roles: ["auditor", "viewer"] });
    const rows = await auditFor(user.id, "user.roles_change");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oldValues).toEqual({ roles: ["cashier"] });
    expect(rows[0]?.newValues).toEqual({ roles: ["auditor", "viewer"] });
  });

  it("an owner cannot remove their own owner role", async () => {
    const res = await asOwner("POST", `/admin/users/${ownerId}/roles`, { roles: ["administrator"] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CANNOT_REMOVE_OWN_OWNER_ROLE");
  });

  it("never leaves the system without an active owner", async () => {
    // Over HTTP only owners hold user.manage, so the self rules catch this first;
    // the service still guards it for any other caller.
    const attempt = changeUserRoles(db, adminId, ownerId, { roles: ["administrator"] });
    await expect(attempt).rejects.toMatchObject({ code: "LAST_OWNER" });
    const deactivate = changeUserStatus(db, adminId, ownerId, { isActive: false, reason: "test" });
    await expect(deactivate).rejects.toBeInstanceOf(UserError);
    await expect(deactivate).rejects.toMatchObject({ code: "LAST_OWNER" });
  });
});

describe("deactivating, unlocking and resetting", () => {
  it("cannot deactivate yourself", async () => {
    const res = await asOwner("POST", `/admin/users/${ownerId}/status`, { isActive: false, reason: "Testing" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CANNOT_DEACTIVATE_SELF");
  });

  it("requires a reason", async () => {
    const user = await createViaApi("needs.reason");
    const res = await asOwner("POST", `/admin/users/${user.id}/status`, { isActive: false });
    expect(res.statusCode).toBe(400);
  });

  it("deactivating signs the user out at once; reactivating lets them back in", async () => {
    const user = await readyUser("leaving.staff");
    const headers = bearer(await tokenFor("leaving.staff"));

    const res = await asOwner("POST", `/admin/users/${user.id}/status`, { isActive: false, reason: "Resigned" });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(401);
    expect((await login("leaving.staff")).statusCode).toBe(401);

    // Same state again: no second audit row.
    await asOwner("POST", `/admin/users/${user.id}/status`, { isActive: false, reason: "Resigned" });

    await asOwner("POST", `/admin/users/${user.id}/status`, { isActive: true, reason: "Rehired" });
    expect((await login("leaving.staff")).statusCode).toBe(200);

    const rows = await auditFor(user.id, "user.status_change");
    expect(rows.map((r) => r.newValues)).toEqual([{ isActive: false }, { isActive: true }]);
    expect(rows.map((r) => r.reason)).toEqual(["Resigned", "Rehired"]);
  });

  it("unlocks a locked account; unlocking an unlocked one writes nothing", async () => {
    const user = await readyUser("locked.out");
    for (let i = 0; i < 5; i++) await login("locked.out", "wrong-password");
    expect((await login("locked.out")).statusCode).toBe(423);

    const listed = (await asOwner("GET", "/admin/users")).json() as { id: string; isLocked: boolean }[];
    expect(listed.find((u) => u.id === user.id)?.isLocked).toBe(true);

    const res = await asOwner("POST", `/admin/users/${user.id}/unlock`, { reason: "Forgot password" });
    expect(res.statusCode).toBe(200);
    expect(res.json().isLocked).toBe(false);
    expect((await login("locked.out")).statusCode).toBe(200);

    await asOwner("POST", `/admin/users/${user.id}/unlock`, {});
    expect(await auditFor(user.id, "user.unlock")).toHaveLength(1);
  });

  it("resets a password: old sessions end, the temporary password works once, no password in the audit", async () => {
    const user = await readyUser("forgot.pass");
    const headers = bearer(await tokenFor("forgot.pass"));

    const res = await asOwner("POST", `/admin/users/${user.id}/reset-password`, {
      temporaryPassword: "fresh-temp-pass",
      reason: "Forgot password",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mustChangePassword).toBe(true);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(401);
    expect((await login("forgot.pass")).statusCode).toBe(401);

    const fresh = await login("forgot.pass", "fresh-temp-pass");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.mustChangePassword).toBe(true);

    const rows = await auditFor(user.id, "user.password_reset");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("fresh-temp-pass");
  });

  it("an owner cannot reset their own password here", async () => {
    const res = await asOwner("POST", `/admin/users/${ownerId}/reset-password`, { temporaryPassword: TEMP });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("USE_CHANGE_PASSWORD");
  });

  it("returns 404 for an unknown user", async () => {
    const res = await asOwner("PATCH", "/admin/users/00000000-0000-4000-8000-000000000009", { fullName: "Nobody" });
    expect(res.statusCode).toBe(404);
  });
});
