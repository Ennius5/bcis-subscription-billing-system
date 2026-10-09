import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { billingRunSchema, invoiceListQuerySchema, invoiceVoidSchema, ledgerQuerySchema } from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { subscribers } from "../db/schema";
import { sendValidationError } from "../http/errors";
import { getSubscriberLedger } from "./ledger";
import {
  BillingError,
  discardBillingDrafts,
  finalizeBilling,
  generateBillingDrafts,
  getBillingSummary,
  getInvoice,
  listInvoices,
  voidInvoice,
} from "./service";

const idParams = z.object({ id: z.uuid() });

function sendBillingError(reply: FastifyReply, err: unknown) {
  if (err instanceof BillingError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerBillingRoutes(app: FastifyInstance, db: Db): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("billing.view")] };
  const canGenerate = { preHandler: [authenticate, requirePermission("billing.generate")] };
  // Voiding reverses a posted invoice, so it has its own permission (spec 4.4).
  const canVoid = { preHandler: [authenticate, requirePermission("billing.void")] };

  /* ---------------------------- Billing runs ---------------------------- */

  app.get("/billing/summary", canView, async (request, reply) => {
    const query = billingRunSchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return getBillingSummary(db, query.data.period);
  });

  app.post("/billing/generate", canGenerate, async (request, reply) => {
    const body = billingRunSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await generateBillingDrafts(db, request.auth!.userId, body.data);
    } catch (err) {
      return sendBillingError(reply, err);
    }
  });

  app.post("/billing/discard-drafts", canGenerate, async (request, reply) => {
    const body = billingRunSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await discardBillingDrafts(db, request.auth!.userId, body.data);
    } catch (err) {
      return sendBillingError(reply, err);
    }
  });

  app.post("/billing/finalize", canGenerate, async (request, reply) => {
    const body = billingRunSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await finalizeBilling(db, request.auth!.userId, body.data);
    } catch (err) {
      return sendBillingError(reply, err);
    }
  });

  /* ------------------------------ Invoices ------------------------------ */

  app.get("/invoices", canView, async (request, reply) => {
    const query = invoiceListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listInvoices(db, query.data);
  });

  app.get("/invoices/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getInvoice(db, params.data.id);
    } catch (err) {
      return sendBillingError(reply, err);
    }
  });

  app.post("/invoices/:id/void", canVoid, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = invoiceVoidSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await voidInvoice(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendBillingError(reply, err);
    }
  });

  /* ------------------------------- Ledger ------------------------------- */

  app.get("/subscribers/:id/ledger", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const query = ledgerQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);

    const [exists] = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.id, params.data.id));
    if (!exists) return reply.code(404).send({ error: "NOT_FOUND", message: "Subscriber not found." });
    return getSubscriberLedger(db, params.data.id, query.data);
  });
}
