import type { FastifyError, FastifyInstance } from "fastify";

// PostgreSQL / node-postgres codes that mean "the database is not reachable right now",
// as opposed to a bug: connection refused, server shutting down, cannot connect, etc.
const DATABASE_DOWN = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P01", "57P02", "57P03", "08001", "08006"]);

function databaseDown(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return DATABASE_DOWN.has(e?.code ?? "") || DATABASE_DOWN.has(e?.cause?.code ?? "");
}

// Fastify's own 4xx errors, reworded for office staff. The code stays for the desktop.
const CLIENT_MESSAGES: Record<number, string> = {
  400: "The request was not understood. Please try again.",
  413: "The request is too large.",
  415: "The request was sent in an unsupported format.",
};

/**
 * One place for every error a route did not answer itself. Expected business errors are
 * already turned into 4xx replies by each module's sendXError helper; whatever reaches
 * this handler is either a malformed request or a bug.
 *
 * Users get a plain sentence and a reference; the stack trace goes only to the log,
 * tagged with the same reference (the request id).
 */
export function registerErrorHandling(app: FastifyInstance): void {
  // Every reply carries its reference, so even a successful call can be traced in the log.
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: "NOT_FOUND", message: `No such endpoint: ${request.method} ${request.url}` }),
  );

  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;

    if (status >= 400 && status < 500) {
      request.log.info({ err: { code: err.code, message: err.message } }, "request rejected");
      return reply.code(status).send({
        error: err.code ?? "BAD_REQUEST",
        message: CLIENT_MESSAGES[status] ?? "The request could not be processed.",
      });
    }

    if (databaseDown(err)) {
      request.log.error({ err }, "database unavailable");
      return reply.code(503).send({
        error: "DATABASE_UNAVAILABLE",
        message: `The database is not available right now. Please try again in a minute. Reference: ${request.id}`,
        reference: request.id,
      });
    }

    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({
      error: "INTERNAL",
      // No promise that nothing was saved: mutations roll back as a whole, but an error after
      // the commit is possible, so staff are told to check before repeating a payment.
      message: `Something went wrong on the server. Check whether your change appears before trying again. If it keeps happening, give this reference to the administrator: ${request.id}`,
      reference: request.id,
    });
  });
}
