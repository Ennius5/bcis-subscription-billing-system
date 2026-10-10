import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, backupHistory, users } from "../db/schema";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { type BackupManifest, DATABASE_FILE, MANIFEST_FILE, PROOFS_FOLDER } from "./manifest";
import { createBackup, verifyBackup } from "./service";

const { db, pool } = createTestDb();
const root = path.join(os.tmpdir(), "bcis-backup-test");
const proofDir = path.join(root, "proofs-source");
const PROOF_NAME = "11111111-2222-4333-8444-555555555555.png";

const config = testConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
  BACKUP_DIR: path.join(root, "backups"),
  PROOF_STORAGE_DIR: proofDir,
});

let ownerId: string;

async function readManifest(folderName: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(path.join(config.BACKUP_DIR, folderName, MANIFEST_FILE), "utf8")) as BackupManifest;
}

beforeAll(async () => {
  await prepareTestDatabase(db);
  ownerId = await createTestUser(db, "backup_owner", "test-password-123", "owner");
  await rm(root, { recursive: true, force: true });
  await mkdir(proofDir, { recursive: true });
  await writeFile(path.join(proofDir, PROOF_NAME), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE integrity_checks, backup_history`);
});

afterAll(async () => {
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

describe("createBackup", () => {
  it("writes the dump, the proof copies and a manifest, then verifies them", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId, note: "Before month end" });

    expect(backup.backupNumber).toMatch(/^BK-\d{6}$/);
    expect(backup.folderName).toMatch(/^BK-\d{6}_\d{8}-\d{6}$/);
    expect(backup.status).toBe("completed");
    expect(backup.verificationStatus).toBe("passed");
    expect(backup.proofFileCount).toBe(1);
    expect(backup.databaseBytes).toBeGreaterThan(0);

    const folder = path.join(config.BACKUP_DIR, backup.folderName);
    expect(existsSync(path.join(folder, DATABASE_FILE))).toBe(true);
    expect(existsSync(path.join(folder, PROOFS_FOLDER, PROOF_NAME))).toBe(true);

    const manifest = await readManifest(backup.folderName);
    expect(manifest.backupNumber).toBe(backup.backupNumber);
    expect(manifest.createdBy).toBe("backup_owner");
    expect(manifest.proofs.map((p) => p.name)).toEqual([PROOF_NAME]);
    // Counted in the dump's own snapshot: here nothing else is writing, so it equals the table now.
    const [userCount] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(manifest.rowCounts.users).toBe(userCount?.n);
    expect(manifest.migrations.applied).toBeGreaterThan(20);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, backup.id));
    expect(audit?.action).toBe("backup.create");
    expect(audit?.actorUserId).toBe(ownerId);
  });

  it("never writes the database password into the manifest", async () => {
    const backup = await createBackup(db, config, { kind: "scheduled", actorUserId: null });
    const password = decodeURIComponent(new URL(config.DATABASE_URL).password);
    const text = await readFile(path.join(config.BACKUP_DIR, backup.folderName, MANIFEST_FILE), "utf8");
    // bcis_test is reached with a password (CLAUDE.md: local role bcis_app), so this check is real.
    expect(password.length).toBeGreaterThan(0);
    expect(text).not.toContain(password);
    expect(JSON.parse(text).createdBy).toBeNull();
  });

  it("refuses to start while another backup is running", async () => {
    await db.insert(backupHistory).values({ backupNumber: "BK-TEST-1", kind: "manual", status: "in_progress", folderName: "x1" });
    await expect(createBackup(db, config, { kind: "manual", actorUserId: ownerId })).rejects.toMatchObject({
      code: "BACKUP_IN_PROGRESS",
    });
  });

  it("closes an attempt cut off by a crash, then backs up normally", async () => {
    await db.insert(backupHistory).values({
      backupNumber: "BK-TEST-2",
      kind: "manual",
      status: "in_progress",
      folderName: "x2",
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    expect(backup.status).toBe("completed");

    const [stale] = await db.select().from(backupHistory).where(eq(backupHistory.backupNumber, "BK-TEST-2"));
    expect(stale?.status).toBe("failed");
    expect(stale?.errorMessage).toContain("Interrupted");
  });

  it("records a failure, removes the half-written folder and says what to fix", async () => {
    const broken = { ...config, PG_BIN_DIR: path.join(root, "no-such-folder") };
    await expect(createBackup(db, broken, { kind: "manual", actorUserId: ownerId })).rejects.toMatchObject({
      code: "BACKUP_FAILED",
    });

    const [row] = await db.select().from(backupHistory);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("PG_BIN_DIR");
    expect(existsSync(path.join(config.BACKUP_DIR, row?.folderName ?? "missing"))).toBe(false);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row?.id ?? ""));
    expect(audit?.newValues).toMatchObject({ status: "failed" });
  });
});

describe("verifyBackup", () => {
  it("detects a changed proof image", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    await writeFile(path.join(config.BACKUP_DIR, backup.folderName, PROOFS_FOLDER, PROOF_NAME), "tampered");

    const checked = await verifyBackup(db, config, backup.id, ownerId);
    expect(checked.verificationStatus).toBe("failed");
    expect(checked.verificationMessage).toContain(PROOF_NAME);

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "backup.verify"));
    expect(rows.at(-1)?.newValues).toMatchObject({ verificationStatus: "failed" });
  });

  it("detects an edited manifest and a missing dump", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    const folder = path.join(config.BACKUP_DIR, backup.folderName);
    const manifest = await readManifest(backup.folderName);
    await writeFile(path.join(folder, MANIFEST_FILE), JSON.stringify({ ...manifest, createdBy: "someone" }));
    await rm(path.join(folder, DATABASE_FILE));

    const checked = await verifyBackup(db, config, backup.id, ownerId);
    expect(checked.verificationStatus).toBe("failed");
    expect(checked.verificationMessage).toContain("manifest.json has changed");
    expect(checked.verificationMessage).toContain("The database file is missing");
  });
});

describe("backup_history protection", () => {
  it("cannot be deleted, and a finished result cannot be rewritten", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    await expect(db.delete(backupHistory).where(eq(backupHistory.id, backup.id))).rejects.toThrow();
    await expect(
      db.update(backupHistory).set({ status: "failed", errorMessage: "x" }).where(eq(backupHistory.id, backup.id)),
    ).rejects.toThrow();
    await expect(
      db.update(backupHistory).set({ folderName: "elsewhere" }).where(eq(backupHistory.id, backup.id)),
    ).rejects.toThrow();
  });
});
