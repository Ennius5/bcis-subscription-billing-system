import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  gcashRejectSchema,
  gcashSubmissionCreateSchema,
  gcashSubmissionListQuerySchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  paymentReverseSchema,
  PROOF_MAX_BYTES,
  PROOF_MIME_TYPES,
} from "@bcis/shared";
import { createAuthenticate } from "../auth/authenticate";
import { requirePermission } from "../auth/guard";
import type { Db } from "../db/client";
import { sendValidationError } from "../http/errors";
import {
  addSubmissionProof,
  createGcashSubmission,
  GcashError,
  getGcashSubmission,
  listGcashSubmissions,
  readSubmissionProof,
  rejectGcashSubmission,
  verifyGcashSubmission,
} from "./gcash";
import { ProofFileError, type ProofStore } from "./proof-storage";
import { getPayment, getPaymentContext, listPayments, PaymentError, postPayment, reversePayment } from "./service";

const idParams = z.object({ id: z.uuid() });

/** One byte over the limit gets through to ProofStore, which answers with our own 413. */
const PROOF_BODY_LIMIT = PROOF_MAX_BYTES + 1;

function sendPaymentError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) {
    return reply
      .code(err.status)
      .send({ error: err.code, message: err.message, ...(err.invoiceId ? { invoiceId: err.invoiceId } : {}) });
  }
  if (err instanceof GcashError || err instanceof ProofFileError) {
    return reply.code(err.status).send({ error: err.code, message: err.message });
  }
  throw err;
}

/** The uploader's file name travels URI-encoded in a header, since the body is the image itself. */
function headerFilename(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function registerPaymentRoutes(app: FastifyInstance, db: Db, store: ProofStore): void {
  const authenticate = createAuthenticate(db);
  const canView = { preHandler: [authenticate, requirePermission("payment.view")] };
  const canCreate = { preHandler: [authenticate, requirePermission("payment.create")] };
  const canReverse = { preHandler: [authenticate, requirePermission("payment.reverse")] };
  const canVerify = { preHandler: [authenticate, requirePermission("gcash.verify")] };

  // Proof uploads are the raw image bytes. Only these three types are parsed at all;
  // any other Content-Type is refused by Fastify with 415 before the route runs.
  app.addContentTypeParser([...PROOF_MIME_TYPES], { parseAs: "buffer", bodyLimit: PROOF_BODY_LIMIT }, (_req, body, done) =>
    done(null, body),
  );

  /* ------------------------------ Payments ------------------------------ */

  app.get("/subscribers/:id/payment-context", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getPaymentContext(db, params.data.id);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.get("/payments", canView, async (request, reply) => {
    const query = paymentListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listPayments(db, query.data);
  });

  app.get("/payments/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getPayment(db, params.data.id);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.post("/payments", canCreate, async (request, reply) => {
    const body = paymentCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    // Choosing which invoices to pay is a separate permission; everyone else gets oldest-first.
    if (body.data.allocations && !request.auth!.permissions.includes("payment.allocate")) {
      return reply.code(403).send({
        error: "FORBIDDEN",
        message: "You do not have permission to choose which invoices a payment pays.",
      });
    }
    try {
      return await postPayment(db, request.auth!.userId, body.data);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.post("/payments/:id/reverse", canReverse, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = paymentReverseSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await reversePayment(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  /* ------------------------------- GCash ------------------------------- */

  app.get("/gcash-submissions", canView, async (request, reply) => {
    const query = gcashSubmissionListQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listGcashSubmissions(db, query.data);
  });

  app.get("/gcash-submissions/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await getGcashSubmission(db, params.data.id);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  // Recording what the customer sent is counter work (payment.create); deciding is gcash.verify.
  app.post("/gcash-submissions", canCreate, async (request, reply) => {
    const body = gcashSubmissionCreateSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await createGcashSubmission(db, request.auth!.userId, body.data);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.post("/gcash-submissions/:id/proofs", { ...canCreate, bodyLimit: PROOF_BODY_LIMIT }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(415).send({ error: "PROOF_INVALID_TYPE", message: "Send the image itself as the request body." });
    }
    try {
      return await addSubmissionProof(db, store, request.auth!.userId, params.data.id, {
        bytes: request.body,
        filename: headerFilename(request.headers["x-filename"]),
      });
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.get("/gcash-proofs/:id", canView, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      const proof = await readSubmissionProof(db, store, params.data.id);
      return await reply
        .header("content-type", proof.mimeType)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(proof.bytes);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.post("/gcash-submissions/:id/verify", canVerify, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    try {
      return await verifyGcashSubmission(db, request.auth!.userId, params.data.id);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.post("/gcash-submissions/:id/reject", canVerify, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = gcashRejectSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return await rejectGcashSubmission(db, request.auth!.userId, params.data.id, body.data);
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });
}
