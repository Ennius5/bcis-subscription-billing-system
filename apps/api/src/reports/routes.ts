import type { FastifyInstance } from "fastify";
import {
  billingVsCollectionExportQuerySchema,
  billingVsCollectionQuerySchema,
  collectionsExportQuerySchema,
  collectionsReportQuerySchema,
  revenueExportQuerySchema,
  revenueQuerySchema,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import { getBillingVsCollection, getRevenueReport } from "./billing";
import { buildBillingVsCollectionDocument, buildRevenueDocument } from "./billing-export";
import { getCollectionsReport } from "./collections";
import { buildCollectionsDocument } from "./collections-export";
import { sendReportExport } from "./export";

/**
 * Reports (Phase 8). Each report has a JSON route for its screen (report.view) and an export
 * route (report.view + report.export) that renders the same data as PDF or XLSX.
 */
export function registerReportRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("report.view")] };
  const canExport = { preHandler: [authenticate, requirePermission("report.view", "report.export")] };

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
}
