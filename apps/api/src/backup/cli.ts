import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { BackupError, createBackup } from "./service";

/*
 * Scheduled backup (Phase 9 decision 7): `pnpm --filter ./apps/api backup`, run by Windows
 * Task Scheduler. Same code as the "Back up now" button; recorded with kind "scheduled"
 * and no user. Exit code 0 = backup made and verified, 1 = anything else, so the task's
 * "last run result" shows a failure.
 */
async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const backup = await createBackup(db, config, { kind: "scheduled", actorUserId: null });
    const megabytes = ((backup.databaseBytes ?? 0) / 1024 / 1024).toFixed(1);
    console.log(
      `${backup.backupNumber} saved in ${config.BACKUP_DIR}\\${backup.folderName} ` +
        `(database ${megabytes} MB, ${backup.proofFileCount} proof images).`,
    );
    if (backup.verificationStatus !== "passed") {
      console.error(`Verification FAILED: ${backup.verificationMessage}`);
      process.exitCode = 1;
    } else {
      console.log("Verification passed.");
    }
  } catch (err) {
    console.error(err instanceof BackupError ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
