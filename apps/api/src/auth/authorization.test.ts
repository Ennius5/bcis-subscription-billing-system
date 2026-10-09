import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { users } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function login(username: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
}

async function tokenFor(username: string): Promise<string> {
  const res = await login(username);
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await createTestUser(db, "owner1", PASSWORD, "owner");
  await createTestUser(db, "cashier1", PASSWORD, "cashier");
  await createTestUser(db, "locktest", PASSWORD, "cashier");
  await createTestUser(db, "deactivated", PASSWORD, "cashier");

  app = buildApp(
    testConfig(),
    { db, pool },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("AT-10: server-side authorization", () => {
  it("rejects requests with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a cashier calling admin-only endpoints directly", async () => {
    const headers = bearer(await tokenFor("cashier1"));

    const userList = await app.inject({ method: "GET", url: "/admin/users", headers });
    expect(userList.statusCode).toBe(403);

    const backup = await app.inject({ method: "POST", url: "/admin/backups", headers });
    expect(backup.statusCode).toBe(403);
  });

  it("allows the owner, and never leaks password hashes", async () => {
    const headers = bearer(await tokenFor("owner1"));
    const res = await app.inject({ method: "GET", url: "/admin/users", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(4);

    const raw = res.body;
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("argon2");
  });
});

describe("sessions", () => {
  it("rejects a token after logout", async () => {
    const headers = bearer(await tokenFor("owner1"));
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/auth/logout", headers });
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(401);
  });

  it("rejects an existing session once the user is deactivated", async () => {
    const headers = bearer(await tokenFor("deactivated"));
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(200);

    await db.update(users).set({ isActive: false }).where(eq(users.username, "deactivated"));
    expect((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode).toBe(401);
  });
});

describe("login lockout", () => {
  it("locks the account after 5 failures, even for the correct password", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login("locktest", "wrong-password");
      expect(res.statusCode).toBe(401);
    }
    expect((await login("locktest", "wrong-password")).statusCode).toBe(423);
    expect((await login("locktest", PASSWORD)).statusCode).toBe(423);
  });

  it("gives the same error for an unknown user as for a wrong password", async () => {
    const unknown = await login("nobody-here", "whatever");
    const wrong = await login("cashier1", "whatever");
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });
});