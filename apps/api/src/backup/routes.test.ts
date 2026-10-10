import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";

const PASSWORD = "test-password-123";
const { db, pool } = createTestDb();
const root = path.join(os.tmpdir(), "bcis-backup-routes-test");
let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(
    sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas, backup_history, integrity_checks CASCADE`,
  );
  await rm(root, { recursive: true, force: true });
  await createTestUser(db, "bk_owner", PASSWORD, "owner");
  await createTestUser(db, "bk_admin", PASSWORD, "administrator");
  await createTestUser(db, "bk_cashier", PASSWORD, "cashier");
  await createTestUser(db, "bk_auditor", PASSWORD, "auditor");

  app = buildApp(
    testConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      BACKUP_DIR: path.join(root, "backups"),
      PROOF_STORAGE_DIR: path.join(root, "proofs"),
    }),
    { db, pool },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

const ANY_ID = "00000000-0000-4000-8000-000000000001";

describe("AT-10: backup routes are owner-only, even when called directly", () => {
  const routes: [string, string, object | undefined][] = [
    ["GET", "/backups", undefined],
    ["POST", "/backups", {}],
    ["POST", `/backups/${ANY_ID}/verify`, {}],
    ["POST", `/backups/${ANY_ID}/test-restore`, {}],
    ["POST", `/backups/${ANY_ID}/restore`, { confirmBackupNumber: "BK-000001", reason: "Testing" }],
    ["GET", "/integrity-checks", undefined],
    ["POST", "/integrity-checks", {}],
  ];

  it("refuses cashiers, administrators and auditors on every route", async () => {
    for (const username of ["bk_cashier", "bk_admin", "bk_auditor"]) {
      const headers = bearer(await tokenFor(username));
      for (const [method, url, payload] of routes) {
        const res = await app.inject({ method: method as "GET", url, headers, ...(payload ? { payload } : {}) });
        expect(res.statusCode, `${username} ${method} ${url}`).toBe(403);
      }
    }
    const [count] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM backup_history`)).rows;
    expect(count?.n).toBe(0);
  });
});

describe("owner workflow", () => {
  let headers: { authorization: string };
  let backupId: string;
  let backupNumber: string;

  beforeAll(async () => {
    headers = bearer(await tokenFor("bk_owner"));
  });

  it("starts stale, then backs up and lists the backup as good", async () => {
    const before = await app.inject({ method: "GET", url: "/backups", headers });
    expect(before.json()).toMatchObject({ items: [], lastGoodBackupAt: null, stale: true });

    const created = await app.inject({ method: "POST", url: "/backups", headers, payload: { note: "Before demo" } });
    expect(created.statusCode).toBe(201);
    backupId = created.json().id as string;
    backupNumber = created.json().backupNumber as string;

    const list = await app.inject({ method: "GET", url: "/backups", headers });
    const body = list.json<{ items: { id: string; note: string; createdByName: string; verificationStatus: string }[]; stale: boolean }>();
    expect(body.stale).toBe(false);
    expect(body.items[0]).toMatchObject({ id: backupId, note: "Before demo", createdByName: "Test owner", verificationStatus: "passed" });
  });

  it("verifies again, test-restores and runs a live integrity check", async () => {
    expect((await app.inject({ method: "POST", url: `/backups/${backupId}/verify`, headers })).json().verificationStatus).toBe("passed");

    const test = await app.inject({ method: "POST", url: `/backups/${backupId}/test-restore`, headers });
    expect(test.statusCode).toBe(200);
    expect(test.json().passed).toBe(true);

    const live = await app.inject({ method: "POST", url: "/integrity-checks", headers });
    expect(live.json().passed).toBe(true);

    const list = await app.inject({ method: "GET", url: "/backups", headers });
    expect(list.json().items[0].lastTestRestore.passed).toBe(true);
    const checks = await app.inject({ method: "GET", url: "/integrity-checks", headers });
    expect(checks.json().map((c: { scope: string }) => c.scope)).toEqual(["live", "test_restore"]);
  });

  it("refuses a restore without the right typed number", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/backups/${backupId}/restore`,
      headers,
      payload: { confirmBackupNumber: "BK-000999", reason: "Testing" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("CONFIRMATION_MISMATCH");
  });

  it("restores, reports the safety backup and the integrity result, and signs everyone out", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/backups/${backupId}/restore`,
      headers,
      payload: { confirmBackupNumber: backupNumber, reason: "Rehearsal" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ backupNumber: string; safetyBackupNumber: string; report: { passed: boolean } }>();
    expect(body.backupNumber).toBe(backupNumber);
    expect(body.safetyBackupNumber).toMatch(/^BK-\d{6}$/);
    expect(body.report.passed).toBe(true);

    expect((await app.inject({ method: "GET", url: "/backups", headers })).statusCode).toBe(401);
    expect(app.maintenance.isActive).toBe(false);
  });
});
