import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  billingVsCollectionExportQuerySchema,
  billingVsCollectionQuerySchema,
  collectionsExportQuerySchema,
  collectionsReportQuerySchema,
  exceptionsExportQuerySchema,
  exceptionsQuerySchema,
  ledgerQuerySchema,
  masterListExportQuerySchema,
  masterListQuerySchema,
  SUBSCRIBER_STATUS_LABELS,
  revenueExportQuerySchema,
  revenueQuerySchema,
  statementExportQuerySchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { describeReceivableFilters } from "../receivables/aging-export";
import { getReceivableFilterOptions } from "../receivables/service";
import { SubscriberError } from "../subscribers/service";
import { getBillingVsCollection, getRevenueReport } from "./billing";
import { buildBillingVsCollectionDocument, buildRevenueDocument } from "./billing-export";
import { getCollectionsReport } from "./collections";
import { buildCollectionsDocument } from "./collections-export";
import { sendReportExport } from "./export";
import { getExceptionsRegister, getMasterList } from "./registers";
import { buildExceptionsDocument, buildMasterListDocument } from "./registers-export";
import { getStatementOfAccount } from "./statement";
import { buildStatementDocument } from "./statement-export";

const idParams = z.object({ id: z.uuid() });

function sendSubscriberError(reply: FastifyReply, err: unknown) {
  if (err instanceof SubscriberError) return reply.code(err.status).send({ error: err.code, message: err.message });
  throw err;
}

/**
 * Reports (Phase 8). Each report has a JSON route for its screen (report.view) and an export
 * route (report.view + report.export) that renders the same data as PDF or XLSX.
 * The Statement of Account is a customer document printed at the counter, so it needs only
 * billing.view (Ethan's decision), and its export is audited against the subscriber.
 */
export function registerReportRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("report.view")] };
  const canExport = { preHandler: [authenticate, requirePermission("report.view", "report.export")] };
  const canViewBilling = { preHandler: [authenticate, requirePermission("billing.view")] };

  app.get("/subscribers/:id/statement", canViewBilling, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const query = ledgerQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    try {
      return await getStatementOfAccount(db, params.data.id, query.data);
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
  });

  app.get("/subscribers/:id/statement/export", canViewBilling, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const query = statementExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...range } = query.data;
    let doc;
    try {
      doc = buildStatementDocument(await getStatementOfAccount(db, params.data.id, range));
    } catch (err) {
      return sendSubscriberError(reply, err);
    }
    return sendReportExport(reply, db, request.auth!, doc, format, range, {
      action: "soa.export",
      entityType: "subscriber",
      entityId: params.data.id,
    });
  });

  app.get("/reports/collections", canView, async (request, reply) => {
    const query = collectionsReportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getCollectionsReport(db, query.data);
  });

  app.get("/reports/collections/export", canExport, async (request, reply) => {
    const query = collectionsExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...filters } = query.data;
    const doc = buildCollectionsDocument(await getCollectionsReport(db, filters));
    return sendReportExport(reply, db, request.auth!, doc, format, filters);
  });

  app.get("/reports/billing-vs-collection", canView, async (request, reply) => {
    const query = billingVsCollectionQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getBillingVsCollection(db, query.data);
  });

  app.get("/reports/billing-vs-collection/export", canExport, async (request, reply) => {
    const query = billingVsCollectionExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...filters } = query.data;
    const doc = buildBillingVsCollectionDocument(await getBillingVsCollection(db, filters));
    return sendReportExport(reply, db, request.auth!, doc, format, filters);
  });

  app.get("/reports/revenue", canView, async (request, reply) => {
    const query = revenueQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getRevenueReport(db, query.data);
  });

  app.get("/reports/revenue/export", canExport, async (request, reply) => {
    const query = revenueExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...filters } = query.data;
    const doc = buildRevenueDocument(await getRevenueReport(db, filters));
    return sendReportExport(reply, db, request.auth!, doc, format, filters);
  });

  app.get("/reports/subscribers", canView, async (request, reply) => {
    const query = masterListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getMasterList(db, query.data);
  });

  app.get("/reports/subscribers/export", canExport, async (request, reply) => {
    const query = masterListExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...filters } = query.data;
    const [list, options] = await Promise.all([getMasterList(db, filters), getReceivableFilterOptions(db)]);
    const lines = [
      ...(filters.status ? [{ label: "Status", value: SUBSCRIBER_STATUS_LABELS[filters.status] }] : []),
      ...describeReceivableFilters(filters, options),
    ];
    return sendReportExport(reply, db, request.auth!, buildMasterListDocument(list, lines), format, filters);
  });

  app.get("/reports/exceptions", canView, async (request, reply) => {
    const query = exceptionsQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getExceptionsRegister(db, query.data);
  });

  app.get("/reports/exceptions/export", canExport, async (request, reply) => {
    const query = exceptionsExportQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { format, ...filters } = query.data;
    const doc = buildExceptionsDocument(await getExceptionsRegister(db, filters));
    return sendReportExport(reply, db, request.auth!, doc, format, filters);
  });
}
