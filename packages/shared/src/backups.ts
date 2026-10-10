import { z } from "zod";

/** The Backup & Restore screen warns when the last good backup is older than this (Phase 9 decision 7). */
export const BACKUP_STALE_AFTER_HOURS = 24;

export const BACKUP_KIND_LABELS: Record<string, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  safety: "Safety copy",
};

export const backupCreateSchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
});
export type BackupCreateInput = z.infer<typeof backupCreateSchema>;

export const backupRestoreSchema = z.strictObject({
  // Typed by the owner; the server compares it with the backup's number.
  confirmBackupNumber: z.string().trim().min(1, "Type the backup number to confirm.").max(20),
  reason: z.string().trim().min(3, "A reason is required.").max(200),
});
export type BackupRestoreInput = z.infer<typeof backupRestoreSchema>;

/** True when there is no good backup, or the newest one is older than the limit. */
export function backupIsStale(lastGoodBackupAt: Date | null, now: Date = new Date()): boolean {
  if (!lastGoodBackupAt) return true;
  return now.getTime() - lastGoodBackupAt.getTime() > BACKUP_STALE_AFTER_HOURS * 60 * 60 * 1000;
}
