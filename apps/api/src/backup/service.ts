import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import { writeAudit } from "../audit/audit";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { takeDocumentNumbers } from "../db/document-numbers";
import { violatedConstraint } from "../db/query_helpers";
import { backupHistory, users } from "../db/schema";
import {
  type BackupManifest,
  DATABASE_FILE,
  describeFile,
  type FileEntry,
  MANIFEST_FILE,
  PROOFS_FOLDER,
  sha256OfText,
  verifyBackupFolder,
} from "./manifest";
import { PgToolError, runPgTool } from "./pg-tools";

export type BackupKind = "manual" | "scheduled" | "safety";

export class BackupError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BACKUP_IN_PROGRESS" | "BACKUP_FAILED" | "NOT_COMPLETED",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type BackupRow = typeof backupHistory.$inferSelect;

type BackupConfig = Pick<Config, "DATABASE_URL" | "BACKUP_DIR" | "PG_BIN_DIR" | "PROOF_STORAGE_DIR">;

/**
 * Counted inside the dump's snapshot and written to the manifest, so a test restore
 * can prove every row came back. Fixed names only: they are put into SQL as written.
 */
export const COUNTED_TABLES = [
  "users",
  "subscribers",
  "service_accounts",
  "invoices",
  "invoice_items",
  "adjustments",
  "payments",
  "payment_allocations",
  "payment_reversals",
  "ledger_entries",
  "collection_batches",
  "collector_remittances",
  "payment_proofs",
  "audit_logs",
] as const;

/** A backup still "in progress" after this long was cut off by a crash or power loss. */
const STALE_AFTER_MS = 60 * 60 * 1000;

function folderOf(config: BackupConfig, row: Pick<BackupRow, "folderName">): string {
  return path.join(config.BACKUP_DIR, row.folderName);
}

async function fetchBackup(db: Db, id: string): Promise<BackupRow> {
  const [row] = await db.select().from(backupHistory).where(eq(backupHistory.id, id));
  if (!row) throw new BackupError("NOT_FOUND", 404, "Backup not found.");
  return row;
}

/** Closes attempts that can no longer finish, so they don't block new backups forever. */
async function closeStaleBackups(db: Db): Promise<void> {
  await db
    .update(backupHistory)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorMessage: "Interrupted: the server stopped before the backup finished.",
    })
    .where(
      and(eq(backupHistory.status, "in_progress"), lt(backupHistory.startedAt, new Date(Date.now() - STALE_AFTER_MS))),
    );
}

async function startBackup(
  db: Db,
  kind: BackupKind,
  actorUserId: string | null,
  note: string | null,
): Promise<BackupRow> {
  try {
    return await db.transaction(async (tx) => {
      const [backupNumber] = await takeDocumentNumbers(tx, "backup", 1);
      if (!backupNumber) throw new Error("No backup number");
      const stamp = await tx.execute<{ stamp: string }>(
        sql`SELECT to_char(now() AT TIME ZONE 'Asia/Manila', 'YYYYMMDD-HH24MISS') AS stamp`,
      );
      const [row] = await tx
        .insert(backupHistory)
        .values({
          backupNumber,
          kind,
          status: "in_progress",
          folderName: `${backupNumber}_${stamp.rows[0]?.stamp ?? "unknown"}`,
          note,
          createdByUserId: actorUserId,
        })
        .returning();
      if (!row) throw new Error("Failed to record the backup");
      return row;
    });
  } catch (err) {
    if (violatedConstraint(err) === "backup_history_one_in_progress") {
      throw new BackupError("BACKUP_IN_PROGRESS", 409, "Another backup is running. Wait for it to finish.");
    }
    throw err;
  }
}

/**
 * Dumps the database from an exported snapshot and counts rows in that same snapshot,
 * so the counts describe exactly what is in the file even while the office keeps working.
 */
async function dumpDatabase(db: Db, config: BackupConfig, dumpPath: string) {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id")).rows[0]?.id;
    if (!snapshot) throw new Error("Could not export a snapshot");

    const counts = await client.query<Record<string, string>>(
      `SELECT ${COUNTED_TABLES.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(", ")}`,
    );
    const rowCounts = Object.fromEntries(
      COUNTED_TABLES.map((t) => [t, Number(counts.rows[0]?.[t] ?? 0)]),
    ) as Record<string, number>;
    const migrationRow = await client.query<{ applied: number; last: string | null }>(
      "SELECT count(*)::int AS applied, max(created_at)::text AS last FROM drizzle.__drizzle_migrations",
    );
    const migrations = {
      applied: migrationRow.rows[0]?.applied ?? 0,
      lastCreatedAt: migrationRow.rows[0]?.last ? Number(migrationRow.rows[0].last) : null,
    };

    // --no-owner/--no-privileges: the dump restores under whichever role runs the restore.
    await runPgTool(
      config.PG_BIN_DIR,
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`, `--file=${dumpPath}`],
      config.DATABASE_URL,
    );
    await client.query("COMMIT");
    return { rowCounts, migrations };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Copies the proof images after the dump: files are written before their database row,
 * so every proof row in the dump already has its file by now.
 */
async function copyProofs(config: BackupConfig, target: string): Promise<FileEntry[]> {
  await mkdir(target, { recursive: true });
  let names: string[];
  try {
    names = (await readdir(config.PROOF_STORAGE_DIR, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .toSorted();
  } catch {
    return []; // no proof has ever been uploaded
  }
  const entries: FileEntry[] = [];
  for (const name of names) {
    const copy = path.join(target, name);
    await copyFile(path.join(config.PROOF_STORAGE_DIR, name), copy);
    entries.push(await describeFile(copy));
  }
  return entries;
}

function failureMessage(err: unknown): string {
  if (err instanceof PgToolError) return err.message;
  return `Backup failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
}

/**
 * Makes one backup: database dump, proof images and manifest in a new folder, then checks
 * it. Used by the Backup & Restore screen, the scheduled script and (step 5) the safety
 * backup taken before a restore. On failure the half-written folder is removed and the
 * attempt stays in the history as failed.
 */
export async function createBackup(
  db: Db,
  config: BackupConfig,
  options: { kind: BackupKind; actorUserId: string | null; note?: string | null },
): Promise<BackupRow> {
  await closeStaleBackups(db);
  const started = await startBackup(db, options.kind, options.actorUserId, options.note ?? null);
  const folder = folderOf(config, started);

  try {
    await mkdir(config.BACKUP_DIR, { recursive: true });
    await mkdir(folder); // a fresh folder: fails rather than mixing into an old one

    const { rowCounts, migrations } = await dumpDatabase(db, config, path.join(folder, DATABASE_FILE));
    const proofs = await copyProofs(config, path.join(folder, PROOFS_FOLDER));
    const database = await describeFile(path.join(folder, DATABASE_FILE));

    let createdBy: string | null = null;
    if (options.actorUserId) {
      const [actor] = await db.select({ username: users.username }).from(users).where(eq(users.id, options.actorUserId));
      createdBy = actor?.username ?? null;
    }

    const manifest: BackupManifest = {
      format: 1,
      backupNumber: started.backupNumber,
      kind: started.kind,
      createdAt: started.startedAt.toISOString(),
      createdBy,
      database,
      proofs,
      rowCounts,
      migrations,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(folder, MANIFEST_FILE), manifestText, { flag: "wx" });
    const manifestSha256 = sha256OfText(manifestText);

    const verification = await verifyBackupFolder(folder, manifestSha256, {
      binDir: config.PG_BIN_DIR,
      databaseUrl: config.DATABASE_URL,
    });
    const proofBytes = proofs.reduce((sum, p) => sum + p.bytes, 0);

    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(backupHistory)
        .set({
          status: "completed",
          completedAt: new Date(),
          databaseBytes: database.bytes,
          proofFileCount: proofs.length,
          proofBytes,
          manifestSha256,
          verificationStatus: verification.passed ? "passed" : "failed",
          verifiedAt: new Date(),
          verificationMessage: verification.passed ? "Checksums match and the dump is readable." : verification.problems.join(" "),
        })
        .where(eq(backupHistory.id, started.id))
        .returning();
      if (!row) throw new Error("Backup row disappeared");
      await writeAudit(tx, {
        actorUserId: options.actorUserId,
        action: "backup.create",
        entityType: "backup",
        entityId: row.id,
        newValues: {
          backupNumber: row.backupNumber,
          kind: row.kind,
          status: row.status,
          databaseBytes: row.databaseBytes,
          proofFileCount: row.proofFileCount,
          verificationStatus: row.verificationStatus,
        },
      });
      return row;
    });
  } catch (err) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    const message = failureMessage(err);
    await db.transaction(async (tx) => {
      await tx
        .update(backupHistory)
        .set({ status: "failed", completedAt: new Date(), errorMessage: message })
        .where(and(eq(backupHistory.id, started.id), eq(backupHistory.status, "in_progress")));
      await writeAudit(tx, {
        actorUserId: options.actorUserId,
        action: "backup.create",
        entityType: "backup",
        entityId: started.id,
        newValues: { backupNumber: started.backupNumber, kind: started.kind, status: "failed", errorMessage: message },
      });
    });
    throw new BackupError("BACKUP_FAILED", 500, `${started.backupNumber} failed. ${message}`);
  }
}

/** Checks an existing backup again (files can be damaged or edited on disk later). */
export async function verifyBackup(
  db: Db,
  config: BackupConfig,
  backupId: string,
  actorUserId: string | null,
): Promise<BackupRow> {
  const backup = await fetchBackup(db, backupId);
  if (backup.status !== "completed" || !backup.manifestSha256) {
    throw new BackupError("NOT_COMPLETED", 409, `${backup.backupNumber} did not complete, so there is nothing to verify.`);
  }
  const result = await verifyBackupFolder(folderOf(config, backup), backup.manifestSha256, {
    binDir: config.PG_BIN_DIR,
    databaseUrl: config.DATABASE_URL,
  });

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(backupHistory)
      .set({
        verificationStatus: result.passed ? "passed" : "failed",
        verifiedAt: new Date(),
        verificationMessage: result.passed ? "Checksums match and the dump is readable." : result.problems.join(" "),
      })
      .where(eq(backupHistory.id, backupId))
      .returning();
    if (!row) throw new BackupError("NOT_FOUND", 404, "Backup not found.");
    await writeAudit(tx, {
      actorUserId,
      action: "backup.verify",
      entityType: "backup",
      entityId: backupId,
      oldValues: { verificationStatus: backup.verificationStatus },
      newValues: { verificationStatus: row.verificationStatus, problems: result.problems },
    });
    return row;
  });
}
