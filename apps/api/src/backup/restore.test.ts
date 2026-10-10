import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  addMonths,
  billingRunSchema,
  paymentCreateSchema,
  periodBounds,
  periodOf,
  planCreateSchema,
  serviceAccountCreateSchema,
  serviceStatusChangeSchema,
  subscriberCreateSchema,
} from "@bcis/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, findActiveSession } from "../auth/session";
import { finalizeBilling, generateBillingDrafts } from "../billing/service";
import { dbToday } from "../db/query_helpers";
import { auditLogs, backupHistory, documentSequences, integrityChecks, payments, users } from "../db/schema";
import { MaintenanceGate } from "../http/maintenance";
import { postPayment, reversePayment } from "../payments/service";
import { createPlan } from "../plans/service";
import { changeServiceStatus, createServiceAccount } from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createTestDb, createTestUser, prepareTestDatabase, testConfig } from "../test/helpers";
import { PROOFS_FOLDER } from "./manifest";
import { checkLiveIntegrity, restoreBackup, testRestore, verifyDatabaseName } from "./restore";
import { createBackup } from "./service";

// One subscriber billed for two months, paid twice, one payment reversed (as in the SOA test),
// plus a proof image on disk. AT-12: back up, change data, restore, integrity passes and the
// backed-up records return.

const { db, pool } = createTestDb();
const root = path.join(os.tmpdir(), "bcis-restore-test");
const PROOF_NAME = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png";
const config = testConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
  BACKUP_DIR: path.join(root, "backups"),
  PROOF_STORAGE_DIR: path.join(root, "proofs"),
});

let ownerId: string;
let cashierId: string;
let subscriberId: string;

const paymentCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(payments))[0]?.n ?? 0;

beforeAll(async () => {
  await prepareTestDatabase(db);
  await db.execute(
    sql`TRUNCATE subscribers, service_plans, billing_cycles, collectors, collection_areas, backup_history, integrity_checks CASCADE`,
  );
  await rm(root, { recursive: true, force: true });
  await mkdir(config.PROOF_STORAGE_DIR, { recursive: true });
  await writeFile(path.join(config.PROOF_STORAGE_DIR, PROOF_NAME), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));

  ownerId = await createTestUser(db, "restore_owner", "test-password-123", "owner");
  cashierId = await createTestUser(db, "restore_cashier", "test-password-123", "cashier");

  const today = await dbToday(db);
  const monthB = addMonths(periodOf(today), -1);
  const monthA = addMonths(monthB, -1);
  const plan = await createPlan(
    db,
    ownerId,
    planCreateSchema.parse({ code: "rst-999", name: "Internet 999", serviceType: "internet", priceCentavos: 99_900 }),
  );
  const subscriber = await createSubscriber(
    db,
    ownerId,
    subscriberCreateSchema.parse({
      fullName: "Restore Demo",
      billingDay: 5,
      address: { line1: "Purok 2", barangay: "Poblacion", city: "Valencia", province: "Bukidnon" },
    }),
  );
  subscriberId = subscriber.id;
  const service = await createServiceAccount(
    db,
    ownerId,
    subscriberId,
    serviceAccountCreateSchema.parse({ planId: plan.id, installationAddressId: subscriber.addresses[0]!.id }),
  );
  await changeServiceStatus(
    db,
    ownerId,
    service.id,
    serviceStatusChangeSchema.parse({ status: "active", reason: "Installed", effectiveDate: periodBounds(monthA).start }),
  );
  for (const period of [monthA, monthB]) {
    await generateBillingDrafts(db, ownerId, billingRunSchema.parse({ period }));
    await finalizeBilling(db, ownerId, billingRunSchema.parse({ period }));
  }
  const first = await postPayment(
    db,
    ownerId,
    paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: 50_000, paymentDate: `${monthA}-10` }),
  );
  await postPayment(
    db,
    ownerId,
    paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: 200_000, paymentDate: `${monthB}-15` }),
  );
  await reversePayment(db, ownerId, first.id, { reason: "Bounced" });
});

afterAll(async () => {
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

describe("integrity check on the live data", () => {
  it("passes on consistent data, and is saved and audited", async () => {
    const report = await checkLiveIntegrity(db, config, ownerId);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks.map((c) => c.code)).toEqual([
      "migrations",
      "invoice_paid",
      "payment_allocated",
      "ledger_balance",
      "counters",
      "proof_files",
    ]);

    const [saved] = await db.select().from(integrityChecks).where(eq(integrityChecks.scope, "live"));
    expect(saved?.passed).toBe(true);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "integrity.check"));
    expect(audit).toHaveLength(1);
  });

  it("fails when a proof image is missing or a counter would repeat a receipt number", async () => {
    const proof = path.join(config.PROOF_STORAGE_DIR, PROOF_NAME);
    await db.execute(sql`
      INSERT INTO payment_proofs (payment_id, storage_key, mime_type, size_bytes, sha256, uploaded_by_user_id)
      SELECT id, 'ffffffff-0000-4000-8000-000000000000.png', 'image/png', 6, repeat('0', 64), ${ownerId}
        FROM payments LIMIT 1`);
    await db.update(documentSequences).set({ nextValue: 1 }).where(eq(documentSequences.name, "receipt"));
    try {
      const report = await checkLiveIntegrity(db, config, ownerId);
      expect(report.passed).toBe(false);
      const failed = Object.fromEntries(report.checks.filter((c) => !c.passed).map((c) => [c.code, c.detail]));
      expect(Object.keys(failed).toSorted()).toEqual(["counters", "proof_files"]);
      expect(failed.proof_files).toContain("ffffffff-0000-4000-8000-000000000000.png");
      expect(failed.counters).toContain("RCPT-");
    } finally {
      await db.execute(sql`TRUNCATE payment_proofs`);
      await db.execute(sql`
        UPDATE document_sequences SET next_value =
          (SELECT max(substring(receipt_number FROM 6)::bigint) + 1 FROM payments) WHERE name = 'receipt'`);
    }
    expect(existsSync(proof)).toBe(true);
  });
});

describe("test restore", () => {
  it("restores into the scratch database, checks it there, and leaves it empty again", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    const result = await testRestore(db, config, backup.id, ownerId);

    expect(result.report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.report.checks.map((c) => c.code)).toContain("row_counts");

    const [saved] = await db.select().from(integrityChecks).where(eq(integrityChecks.scope, "test_restore"));
    expect(saved?.backupId).toBe(backup.id);
    expect(saved?.passed).toBe(true);

    const scratch = new URL(config.DATABASE_URL);
    scratch.pathname = `/${verifyDatabaseName(config.DATABASE_URL)}`;
    const client = new Client({ connectionString: scratch.toString() });
    await client.connect();
    const tables = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    await client.end();
    expect(tables.rows[0]?.n).toBe(0);
  });

  it("refuses a damaged backup", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    await writeFile(path.join(config.BACKUP_DIR, backup.folderName, PROOFS_FOLDER, PROOF_NAME), "tampered");
    await expect(testRestore(db, config, backup.id, ownerId)).rejects.toMatchObject({ code: "BACKUP_DAMAGED" });
  });
});

describe("AT-12: back up, change data, restore", () => {
  it("brings back the backed-up records, passes the integrity check and keeps the history", async () => {
    const backup = await createBackup(db, config, { kind: "manual", actorUserId: ownerId, note: "AT-12" });
    const paymentsAtBackup = await paymentCount();

    // Changes after the backup: a new payment, a new user, a deleted proof image, a live session.
    await postPayment(
      db,
      ownerId,
      paymentCreateSchema.parse({ subscriberId, method: "cash", amountCentavos: 10_000, paymentDate: await dbToday(db) }),
    );
    await createTestUser(db, "made_after_backup", "test-password-123", "viewer");
    await rm(path.join(config.PROOF_STORAGE_DIR, PROOF_NAME));
    const cashierToken = await createSession(db, cashierId);
    expect(await paymentCount()).toBe(paymentsAtBackup + 1);

    const gate = new MaintenanceGate();
    const input = { backupId: backup.id, reason: "AT-12 rehearsal" };

    // A wrong confirmation changes nothing.
    await expect(
      restoreBackup(db, config, gate, { ...input, confirmBackupNumber: "BK-999999" }, { userId: ownerId, ownRequests: 0 }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(await paymentCount()).toBe(paymentsAtBackup + 1);

    const result = await restoreBackup(
      db,
      config,
      gate,
      { ...input, confirmBackupNumber: backup.backupNumber.toLowerCase() },
      { userId: ownerId, ownRequests: 0 },
    );

    // The restored database passes the integrity check, row counts included.
    expect(result.report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.report.checks.map((c) => c.code)).toContain("row_counts");

    // The expected records return; what came after the backup is gone.
    expect(await paymentCount()).toBe(paymentsAtBackup);
    expect(await db.select().from(users).where(eq(users.username, "made_after_backup"))).toHaveLength(0);
    expect(existsSync(path.join(config.PROOF_STORAGE_DIR, PROOF_NAME))).toBe(true);

    // Nobody stays signed in with a session from before.
    expect(await findActiveSession(db, cashierToken)).toBeNull();

    // History survives the restore: every backup, including the safety copy, and earlier checks.
    const history = await db.select().from(backupHistory);
    expect(history.find((h) => h.id === backup.id)?.status).toBe("completed");
    expect(history.find((h) => h.id === result.safetyBackup.id)?.kind).toBe("safety");
    expect(history.every((h) => h.status !== "in_progress")).toBe(true);
    const checks = await db.select().from(integrityChecks);
    expect(checks.map((c) => c.scope).toSorted()).toEqual(["after_restore", "live", "live", "test_restore"]);

    // The next backup number continues after the safety backup, never repeating one.
    const next = await createBackup(db, config, { kind: "manual", actorUserId: ownerId });
    expect(history.map((h) => h.backupNumber)).not.toContain(next.backupNumber);

    // Audited after the restore, with who did it and the safety copy.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "backup.restore"), eq(auditLogs.entityId, backup.id)));
    expect(audit?.actorUserId).toBe(ownerId);
    expect(audit?.reason).toBe("AT-12 rehearsal");
    expect(audit?.newValues).toMatchObject({
      status: "completed",
      safetyBackupNumber: result.safetyBackup.backupNumber,
      restoredBy: "restore_owner",
      integrityPassed: true,
    });
  });
});
