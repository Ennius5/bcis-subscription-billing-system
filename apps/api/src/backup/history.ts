import { and, desc, eq, sql } from "drizzle-orm";
import { backupIsStale } from "@bcis/shared";
import type { Db } from "../db/client";
import { backupHistory, integrityChecks, users } from "../db/schema";
import type { IntegrityCheck } from "./integrity";

/** The newest backups on the screen; older ones stay in the table and on disk. */
const LIST_LIMIT = 100;
const CHECKS_LIMIT = 20;

export interface BackupListItem {
  id: string;
  backupNumber: string;
  kind: string;
  status: string;
  folderName: string;
  note: string | null;
  createdByName: string | null;
  startedAt: Date;
  completedAt: Date | null;
  databaseBytes: number | null;
  proofFileCount: number | null;
  proofBytes: number | null;
  verificationStatus: string | null;
  verifiedAt: Date | null;
  verificationMessage: string | null;
  errorMessage: string | null;
  /** The most recent test restore of this backup, if any. */
  lastTestRestore: { passed: boolean; ranAt: Date } | null;
}

export interface BackupList {
  items: BackupListItem[];
  /** Newest backup that completed and passed verification. */
  lastGoodBackupAt: Date | null;
  stale: boolean;
}

export async function listBackups(db: Db): Promise<BackupList> {
  const lastTest = db
    .selectDistinctOn([integrityChecks.backupId], {
      backupId: integrityChecks.backupId,
      passed: integrityChecks.passed,
      ranAt: integrityChecks.ranAt,
    })
    .from(integrityChecks)
    .where(eq(integrityChecks.scope, "test_restore"))
    .orderBy(integrityChecks.backupId, desc(integrityChecks.ranAt))
    .as("last_test");

  const rows = await db
    .select({
      id: backupHistory.id,
      backupNumber: backupHistory.backupNumber,
      kind: backupHistory.kind,
      status: backupHistory.status,
      folderName: backupHistory.folderName,
      note: backupHistory.note,
      createdByName: users.fullName,
      startedAt: backupHistory.startedAt,
      completedAt: backupHistory.completedAt,
      databaseBytes: backupHistory.databaseBytes,
      proofFileCount: backupHistory.proofFileCount,
      proofBytes: backupHistory.proofBytes,
      verificationStatus: backupHistory.verificationStatus,
      verifiedAt: backupHistory.verifiedAt,
      verificationMessage: backupHistory.verificationMessage,
      errorMessage: backupHistory.errorMessage,
      testPassed: lastTest.passed,
      testRanAt: lastTest.ranAt,
    })
    .from(backupHistory)
    .leftJoin(users, eq(users.id, backupHistory.createdByUserId))
    .leftJoin(lastTest, eq(lastTest.backupId, backupHistory.id))
    .orderBy(desc(backupHistory.startedAt))
    .limit(LIST_LIMIT);

  const [good] = await db
    .select({ at: sql<Date | null>`max(${backupHistory.completedAt})` })
    .from(backupHistory)
    .where(and(eq(backupHistory.status, "completed"), eq(backupHistory.verificationStatus, "passed")));
  const lastGoodBackupAt = good?.at ? new Date(good.at) : null;

  return {
    items: rows.map(({ testPassed, testRanAt, ...row }) => ({
      ...row,
      lastTestRestore: testPassed === null || testRanAt === null ? null : { passed: testPassed, ranAt: testRanAt },
    })),
    lastGoodBackupAt,
    stale: backupIsStale(lastGoodBackupAt),
  };
}

export interface IntegrityCheckRun {
  id: string;
  scope: string;
  backupNumber: string | null;
  passed: boolean;
  checks: IntegrityCheck[];
  runByName: string | null;
  ranAt: Date;
}

export async function listIntegrityChecks(db: Db): Promise<IntegrityCheckRun[]> {
  const rows = await db
    .select({
      id: integrityChecks.id,
      scope: integrityChecks.scope,
      backupNumber: backupHistory.backupNumber,
      passed: integrityChecks.passed,
      checks: integrityChecks.results,
      runByName: users.fullName,
      ranAt: integrityChecks.ranAt,
    })
    .from(integrityChecks)
    .leftJoin(backupHistory, eq(backupHistory.id, integrityChecks.backupId))
    .leftJoin(users, eq(users.id, integrityChecks.runByUserId))
    .orderBy(desc(integrityChecks.ranAt))
    .limit(CHECKS_LIMIT);
  return rows.map((r) => ({ ...r, checks: r.checks as IntegrityCheck[] }));
}
