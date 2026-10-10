import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  collectorReportExportQuerySchema,
  batchAccountAddSchema,
  batchCancelSchema,
  batchCloseSchema,
  batchCreateSchema,
  batchListQuerySchema,
  batchReconcileSchema,
  collectorReportQuerySchema,
  fieldCollectionCreateSchema,
  remittanceCreateSchema,
  remittanceVoidSchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { sendReportExport } from "../reports/export";
import { PaymentError } from "../payments/service";
import { buildCollectorReportDocument } from "./report-export";
import {
  addBatchAccount,
  BatchError,
  cancelBatch,
  createBatch,
  dispatchBatch,
  getBatch,
  listBatches,
  removeBatchAccount,
  submitBatch,
} from "./batches";
import { recordFieldCollection, recordRemittance, voidRemittance } from "./field-collections";
import { closeBatch, reconcileBatch } from "./reconciliation";
import { getCollectorReport } from "./report";

const idParams = z.object({ id: z.uuid() });
const accountParams = z.object({ id: z.uuid(), subscriberId: z.uuid() });
const remittanceParams = z.object({ id: z.uuid(), remittanceId: z.uuid() });

/** Field collections post through the payment service, so its errors can come back too. */
function sendBatchError(reply: FastifyReply, err: unknown) {
  if (err instanceof BatchError || err instanceof PaymentError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Collection batches (spec 3.8). Reading needs collection.view; running a batch (build,
 * dispatch, record collections, submit, remittances, cancel) needs collection.manage.
 * Reconciling and closing are their own permissions, collection.reconcile and
 * collection.close, held by the collection supervisor and the owner.
 */
export function registerBatchRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("collection.view")] };
  const canManage = { preHandler: [authenticate, requirePermission("collection.manage")] };
  const canReconcile = { preHandler: [authenticate, requirePermission("collection.reconcile")] };
  const canClose = { preHandler: [authenticate, requirePermission("collection.close")] };

  /* ------------------------------ Reading ------------------------------ */

  app.get("/collection-batches", canView, async (request, reply) => {
    const query = batchListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listBatches(db, query.data);
  });

  app.get("/collection-batches/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getBatch(db, params.data.id);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  // Collector report: collection, remittance, shortage/overage and rate per collector.
  app.get("/collection-reports/collectors", canView, async (request, reply) => {
    const query = collectorReportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getCollectorReport(db, query.data);
  });

  app.get(
    "/collection-reports/collectors/export",
    { preHandler: [authenticate, requirePermission("collection.view", "report.export")] },
    async (request, reply) => {
      const query = collectorReportExportQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error);
      const { format, ...filters } = query.data;
      const doc = buildCollectorReportDocument(await getCollectorReport(db, filters));
      return sendReportExport(reply, db, request.auth!, doc, format, filters);
    },
  );

  /* ------------------------------ Building ------------------------------ */

  app.post("/collection-batches", canManage, async (request, reply) => {
    const body = batchCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const result = await createBatch(db, request.auth!.userId, body.data);
      return reply.code(201).send(result);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/accounts", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = batchAccountAddSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await addBatchAccount(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  // Only while the batch is open: the row is a draft route-sheet line nothing points at yet.
  app.delete("/collection-batches/:id/accounts/:subscriberId", canManage, async (request, reply) => {
    const params = accountParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await removeBatchAccount(db, request.auth!.userId, params.data.id, params.data.subscriberId);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  /* ------------------------------ Lifecycle ------------------------------ */

  app.post("/collection-batches/:id/dispatch", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await dispatchBatch(db, request.auth!.userId, params.data.id);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/submit", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await submitBatch(db, request.auth!.userId, params.data.id);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/cancel", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = batchCancelSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await cancelBatch(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  /* ------------------------- Collections and cash ------------------------- */

  app.post("/collection-batches/:id/collections", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = fieldCollectionCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const payment = await recordFieldCollection(db, request.auth!.userId, params.data.id, body.data);
      return reply.code(201).send(payment);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/remittances", canManage, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = remittanceCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await recordRemittance(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/remittances/:remittanceId/void", canManage, async (request, reply) => {
    const params = remittanceParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = remittanceVoidSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await voidRemittance(db, request.auth!.userId, params.data.id, params.data.remittanceId, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  /* ------------------------ Reconcile and close ------------------------ */

  app.post("/collection-batches/:id/reconcile", canReconcile, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = batchReconcileSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await reconcileBatch(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });

  app.post("/collection-batches/:id/close", canClose, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = batchCloseSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await closeBatch(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBatchError(reply, err);
    }
  });
}
