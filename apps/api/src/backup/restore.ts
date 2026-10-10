import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import { writeAudit } from "../audit/audit";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { expectedMigrationCount } from "../db/migrations-folder";
import { backupHistory, documentSequences, integrityChecks, sessions, users } from "../db/schema";
import type { MaintenanceGate } from "../http/maintenance";
import { type IntegrityReport, runIntegrityChecks } from "./integrity";
import { type BackupManifest, DATABASE_FILE, MANIFEST_FILE, PROOFS_FOLDER, verifyBackupFolder } from "./manifest";
import { runPgTool } from "./pg-tools";
import { BackupError, type BackupRow, createBackup } from "./service";

type RestoreConfig = Pick<Config, "DATABASE_URL" | "BACKUP_DIR" | "PG_BIN_DIR" | "PROOF_STORAGE_DIR">;

export class RestoreError extends Error {
  constructor(
    public readonly code:
      | "BACKUP_DAMAGED"
      | "CONFIRMATION_MISMATCH"
      | "VERSION_MISMATCH"
      | "SAFETY_BACKUP_FAILED"
      | "RESTORE_FAILED"
      | "RESTORE_BUSY",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface LoadedBackup {
  backup: BackupRow;
  folder: string;
  manifest: BackupManifest;
}

/* ------------------------------ Helpers ------------------------------ */

function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
}

/** bcis -> bcis_verify. Created once by the superuser (deployment guide), owned by the app role. */
export function verifyDatabaseName(databaseUrl: string): string {
  return `${databaseName(databaseUrl)}_verify`;
}

function urlFor(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

// One restore or test restore at a time in this server (both use bcis_verify or the live data).
let restoreRunning = false;

async function exclusively<T>(work: () => Promise<T>): Promise<T> {
  if (restoreRunning) throw new RestoreError("RESTORE_BUSY", 409, "A restore or test restore is already running.");
  restoreRunning = true;
  try {
    return await work();
  } finally {
    restoreRunning = false;
  }
}

/** The backup must be complete and its files must still match the manifest. */
async function loadBackup(db: Db, config: RestoreConfig, backupId: string): Promise<LoadedBackup> {
  const [backup] = await db.select().from(backupHistory).where(eq(backupHistory.id, backupId));
  if (!backup) throw new BackupError("NOT_FOUND", 404, "Backup not found.");
  if (backup.status !== "completed" || !backup.manifestSha256) {
    throw new BackupError("NOT_COMPLETED", 409, `${backup.backupNumber} did not complete and cannot be restored.`);
  }
  const folder = path.join(config.BACKUP_DIR, backup.folderName);
  const check = await verifyBackupFolder(folder, backup.manifestSha256, {
    binDir: config.PG_BIN_DIR,
    databaseUrl: config.DATABASE_URL,
  });
  if (!check.passed) {
    throw new RestoreError("BACKUP_DAMAGED", 409, `${backup.backupNumber} is damaged: ${check.problems.join(" ")}`);
  }
  const manifest = JSON.parse(await readFile(path.join(folder, MANIFEST_FILE), "utf8")) as BackupManifest;
  return { backup, folder, manifest };
}

/** Empties a scratch database completely (tables, functions, the pg_trgm extension, drizzle's journal). */
async function emptyDatabase(client: Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
}

function restoreArgs(database: string, dumpPath: string, clean: boolean): string[] {
  return [
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    // All or nothing: if any statement fails, the database is left exactly as it was.
    "--single-transaction",
    ...(clean ? ["--clean", "--if-exists"] : []),
    `--dbname=${database}`,
    dumpPath,
  ];
}

async function userExists(db: Db, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return row !== undefined;
}

/* ------------------------------ Test restore ------------------------------ */

export interface TestRestoreResult {
  backup: BackupRow;
  report: IntegrityReport;
}

/**
 * Restores a backup into the scratch database, runs the integrity check there and compares
 * row counts with the manifest (AT-12 evidence without touching live data). The result is
 * saved in integrity_checks either way, then the scratch database is emptied again.
 */
export async function testRestore(
  db: Db,
  config: RestoreConfig,
  backupId: string,
  actorUserId: string | null,
): Promise<TestRestoreResult> {
  return exclusively(async () => {
    const { backup, folder, manifest } = await loadBackup(db, config, backupId);
    const scratch = verifyDatabaseName(config.DATABASE_URL);
    const client = new Client({ connectionString: urlFor(config.DATABASE_URL, scratch) });

    let report: IntegrityReport;
    try {
      await client.connect();
      await emptyDatabase(client);
      await runPgTool(config.PG_BIN_DIR, "pg_restore", restoreArgs(scratch, path.join(folder, DATABASE_FILE), false), config.DATABASE_URL, scratch);
      report = await runIntegrityChecks(client, {
        proofDir: path.join(folder, PROOFS_FOLDER),
        expectedRowCounts: manifest.rowCounts,
      });
    } catch (err) {
      report = {
        passed: false,
        checks: [
          {
            code: "restore",
            label: "The backup can be restored",
            passed: false,
            detail: `Restoring into ${scratch} failed: ${(err as Error).message}`,
          },
        ],
      };
    } finally {
      await emptyDatabase(client).catch(() => undefined);
      await client.end().catch(() => undefined);
    }

    await db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(integrityChecks)
        .values({ scope: "test_restore", backupId, passed: report.passed, results: report.checks, runByUserId: actorUserId })
        .returning({ id: integrityChecks.id });
      await writeAudit(tx, {
        actorUserId,
        action: "backup.test_restore",
        entityType: "backup",
        entityId: backupId,
        newValues: { backupNumber: backup.backupNumber, passed: report.passed, integrityCheckId: saved?.id },
      });
    });
    return { backup, report };
  });
}

/* ------------------------------ Live integrity check ------------------------------ */

/** The integrity check on the live data, on demand. Saved like every other run. */
export async function checkLiveIntegrity(
  db: Db,
  config: RestoreConfig,
  actorUserId: string | null,
): Promise<IntegrityReport> {
  const report = await runIntegrityChecks(db.$client, { proofDir: config.PROOF_STORAGE_DIR });
  await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(integrityChecks)
      .values({ scope: "live", passed: report.passed, results: report.checks, runByUserId: actorUserId })
      .returning({ id: integrityChecks.id });
    await writeAudit(tx, {
      actorUserId,
      action: "integrity.check",
      entityType: "integrity_check",
      entityId: saved?.id ?? null,
      newValues: { scope: "live", passed: report.passed },
    });
  });
  return report;
}

/* ------------------------------ Restore ------------------------------ */

export interface RestoreInput {
  backupId: string;
  /** The owner types the backup number, so a misclick cannot replace the data. */
  confirmBackupNumber: string;
  reason: string;
}

export interface RestoreResult {
  backup: BackupRow;
  safetyBackup: BackupRow;
  report: IntegrityReport;
}

/**
 * Replaces the live data with a backup (Phase 9 decision 6):
 *   1. checks the backup is intact and made by this version of the system;
 *   2. locks everyone out (maintenance mode) and waits for running requests;
 *   3. takes a safety backup of the current data;
 *   4. restores the dump in ONE transaction (on failure nothing changes);
 *   5. puts back the backup and integrity history, which must outlive the restore;
 *   6. signs everyone out: sessions in an old backup must not come back to life;
 *   7. copies the proof images back, runs the integrity check, and records the restore
 *      in the audit log, after the restore, since the restore replaced the audit log.
 */
export async function restoreBackup(
  db: Db,
  config: RestoreConfig,
  gate: MaintenanceGate,
  input: RestoreInput,
  actor: { userId: string; ownRequests: number },
): Promise<RestoreResult> {
  return exclusively(async () => {
    const { backup, folder, manifest } = await loadBackup(db, config, input.backupId);
    if (input.confirmBackupNumber.trim().toUpperCase() !== backup.backupNumber) {
      throw new RestoreError("CONFIRMATION_MISMATCH", 422, `Type ${backup.backupNumber} exactly to confirm the restore.`);
    }
    const expected = await expectedMigrationCount();
    if (manifest.migrations.applied !== expected) {
      throw new RestoreError(
        "VERSION_MISMATCH",
        409,
        `${backup.backupNumber} was made by a different version of the system (${manifest.migrations.applied} migrations, this version has ${expected}). It cannot be restored here.`,
      );
    }
    const [actorRow] = await db.select({ username: users.username }).from(users).where(eq(users.id, actor.userId));

    return gate.run(
      async () => {
        let safetyBackup: BackupRow;
        try {
          safetyBackup = await createBackup(db, config, {
            kind: "safety",
            actorUserId: actor.userId,
            note: `Safety copy before restoring ${backup.backupNumber}`,
          });
        } catch (err) {
          throw new RestoreError("SAFETY_BACKUP_FAILED", 500, `No restore was done: the safety backup failed. ${(err as Error).message}`);
        }
        if (safetyBackup.verificationStatus !== "passed") {
          throw new RestoreError("SAFETY_BACKUP_FAILED", 500, `No restore was done: safety backup ${safetyBackup.backupNumber} did not pass verification.`);
        }

        // History that must survive: the restored copy only knows what existed back then.
        const savedHistory = await db.select().from(backupHistory);
        const savedChecks = await db.select().from(integrityChecks);
        const [counter] = await db
          .select({ next: documentSequences.nextValue })
          .from(documentSequences)
          .where(eq(documentSequences.name, "backup"));

        const live = databaseName(config.DATABASE_URL);
        try {
          await runPgTool(config.PG_BIN_DIR, "pg_restore", restoreArgs(live, path.join(folder, DATABASE_FILE), true), config.DATABASE_URL);
        } catch (err) {
          await writeAudit(db, {
            actorUserId: actor.userId,
            action: "backup.restore",
            entityType: "backup",
            entityId: backup.id,
            reason: input.reason,
            newValues: { backupNumber: backup.backupNumber, status: "failed", safetyBackupNumber: safetyBackup.backupNumber },
          });
          throw new RestoreError("RESTORE_FAILED", 500, `The restore failed and nothing was changed. ${(err as Error).message}`);
        }

        await db.transaction(async (tx) => {
          // Users created after the backup no longer exist; keep their history rows without the link.
          const ids = [...new Set([...savedHistory.map((h) => h.createdByUserId), ...savedChecks.map((c) => c.runByUserId)])]
            .filter((id): id is string => id !== null);
          const present = new Set(
            ids.length === 0
              ? []
              : (await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids))).map((u) => u.id),
          );
          const known = (id: string | null) => (id && present.has(id) ? id : null);

          await tx.execute(sql`TRUNCATE integrity_checks, backup_history`);
          if (savedHistory.length > 0) {
            await tx.insert(backupHistory).values(savedHistory.map((h) => ({ ...h, createdByUserId: known(h.createdByUserId) })));
          }
          if (savedChecks.length > 0) {
            await tx.insert(integrityChecks).values(savedChecks.map((c) => ({ ...c, runByUserId: known(c.runByUserId) })));
          }
          if (counter) {
            await tx
              .update(documentSequences)
              .set({ nextValue: sql`greatest(${documentSequences.nextValue}, ${counter.next})` })
              .where(eq(documentSequences.name, "backup"));
          }
          await tx.update(sessions).set({ revokedAt: new Date() }).where(sql`${sessions.revokedAt} IS NULL`);
        });

        // Files present now but not in the backup stay: they harm nothing and are evidence.
        await mkdir(config.PROOF_STORAGE_DIR, { recursive: true });
        for (const proof of manifest.proofs) {
          await copyFile(path.join(folder, PROOFS_FOLDER, proof.name), path.join(config.PROOF_STORAGE_DIR, proof.name));
        }

        const report = await runIntegrityChecks(db.$client, {
          proofDir: config.PROOF_STORAGE_DIR,
          expectedRowCounts: manifest.rowCounts,
        });

        // The restoring owner may not exist in an older backup: the audit then names them in text.
        const actorKnown = (await userExists(db, actor.userId)) ? actor.userId : null;
        await db.transaction(async (tx) => {
          await tx.insert(integrityChecks).values({
            scope: "after_restore",
            backupId: backup.id,
            passed: report.passed,
            results: report.checks,
            runByUserId: actorKnown,
          });
          await writeAudit(tx, {
            actorUserId: actorKnown,
            action: "backup.restore",
            entityType: "backup",
            entityId: backup.id,
            reason: input.reason,
            newValues: {
              backupNumber: backup.backupNumber,
              status: "completed",
              safetyBackupNumber: safetyBackup.backupNumber,
              restoredBy: actorRow?.username ?? null,
              integrityPassed: report.passed,
            },
          });
        });

        const [restored] = await db.select().from(backupHistory).where(eq(backupHistory.id, backup.id));
        return { backup: restored ?? backup, safetyBackup, report };
      },
      { ownRequests: actor.ownRequests },
    );
  });
}
