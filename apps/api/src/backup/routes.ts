import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { backupCreateSchema, backupRestoreSchema } from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { MaintenanceBusyError } from "../http/maintenance";
import { listBackups, listIntegrityChecks } from "./history";
import { checkLiveIntegrity, restoreBackup, RestoreError, testRestore } from "./restore";
import { BackupError, createBackup, verifyBackup } from "./service";

const idParams = z.object({ id: z.uuid() });

function sendBackupError(reply: FastifyReply, err: unknown) {
  if (err instanceof BackupError || err instanceof RestoreError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  if (err instanceof MaintenanceBusyError) {
    return reply.code(409).send({ error: "MAINTENANCE_BUSY", message: err.message });
  }
  throw err;
}

/**
 * Backup & Restore (spec 3.1: owner only). backup.create covers everything that leaves the
 * live data alone: making, listing and checking backups, test restores and integrity checks.
 * Only the restore itself needs backup.restore.
 */
export function registerBackupRoutes(app: FastifyInstance, db: Db, config: Config): void {
  const authenticate = createAuthenticate(db);
  const canBackup = { preHandler: [authenticate, requirePermission("backup.create")] };
  const canRestore = { preHandler: [authenticate, requirePermission("backup.restore")] };

  app.get("/backups", canBackup, async () => listBackups(db));

  app.post("/backups", canBackup, async (request, reply) => {
    const body = backupCreateSchema.safeParse(request.body ?? {});
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const backup = await createBackup(db, config, {
        kind: "manual",
        actorUserId: request.auth!.userId,
        note: body.data.note || null,
      });
      return reply.code(201).send(backup);
    } catch (err) {
      return sendBackupError(reply, err);
    }
  });

  app.post("/backups/:id/verify", canBackup, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await verifyBackup(db, config, params.data.id, request.auth!.userId);
    } catch (err) {
      return sendBackupError(reply, err);
    }
  });

  app.post("/backups/:id/test-restore", canBackup, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      const { report } = await testRestore(db, config, params.data.id, request.auth!.userId);
      return report;
    } catch (err) {
      return sendBackupError(reply, err);
    }
  });

  app.post("/backups/:id/restore", canRestore, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = backupRestoreSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const result = await restoreBackup(
        db,
        config,
        app.maintenance,
        { backupId: params.data.id, ...body.data },
        // This request itself is in flight while the gate waits for the others.
        { userId: request.auth!.userId, ownRequests: 1 },
      );
      return {
        backupNumber: result.backup.backupNumber,
        safetyBackupNumber: result.safetyBackup.backupNumber,
        report: result.report,
      };
    } catch (err) {
      return sendBackupError(reply, err);
    }
  });

  app.get("/integrity-checks", canBackup, async () => listIntegrityChecks(db));

  app.post("/integrity-checks", canBackup, async (request) => checkLiveIntegrity(db, config, request.auth!.userId));
}
