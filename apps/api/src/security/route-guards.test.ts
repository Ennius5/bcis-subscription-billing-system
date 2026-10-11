import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { hashPassword } from "../auth/password";
import { users } from "../db/schema";
import { createTestDb, prepareTestDatabase, testConfig } from "../test/helpers";

/*
 * Security review (spec 4.4, AT-10): server-side authorization on EVERY route.
 * The test walks the live route table, so a route added later without
 * `authenticate` + `requirePermission` fails here even if nobody wrote a test for it.
 */

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
let app: FastifyInstance;
let noRolesToken: string;

/** Answer without a session: sign-in and health checks. */
const PUBLIC = new Set(["GET /health", "GET /health/db", "POST /auth/login"]);
/** Need a session but no permission: they only touch the caller's own account. */
const OWN_ACCOUNT = new Set(["GET /auth/me", "POST /auth/logout", "POST /auth/password"]);

const ANY_ID = "00000000-0000-4000-8000-000000000001";
const withIds = (url: string) => url.replace(/:[A-Za-z]+/g, ANY_ID);

beforeAll(async () => {
  await prepareTestDatabase(db);
  // Signed in, but holds no role: every permission check must refuse this user.
  await db.insert(users).values({ username: "no_roles", fullName: "No Roles", passwordHash: await hashPassword(PASSWORD) });
  app = buildApp(testConfig(), { db, pool });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "no_roles", password: PASSWORD } });
  noRolesToken = login.json().token as string;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("every API route is guarded on the server", () => {
  it("knows the whole route table", () => {
    expect(app.routeTable.length).toBeGreaterThan(80);
    for (const key of [...PUBLIC, ...OWN_ACCOUNT]) {
      expect(app.routeTable.map((r) => `${r.method} ${r.url}`)).toContain(key);
    }
  });

  it("refuses every non-public route without a session (401)", async () => {
    const unguarded: string[] = [];
    for (const route of app.routeTable) {
      const key = `${route.method} ${route.url}`;
      if (PUBLIC.has(key)) continue;
      const res = await app.inject({ method: route.method as "GET", url: withIds(route.url) });
      if (res.statusCode !== 401) unguarded.push(`${key} -> ${res.statusCode}`);
    }
    expect(unguarded).toEqual([]);
  });

  it("refuses every permission-protected route to a signed-in user with no role (403)", async () => {
    const unguarded: string[] = [];
    for (const route of app.routeTable) {
      const key = `${route.method} ${route.url}`;
      if (PUBLIC.has(key) || OWN_ACCOUNT.has(key)) continue;
      const res = await app.inject({
        method: route.method as "GET",
        url: withIds(route.url),
        headers: { authorization: `Bearer ${noRolesToken}` },
      });
      if (res.statusCode !== 403) unguarded.push(`${key} -> ${res.statusCode}`);
    }
    expect(unguarded).toEqual([]);
  });
});
