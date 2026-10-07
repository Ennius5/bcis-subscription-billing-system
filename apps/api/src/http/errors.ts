import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** Standard 400 response for failed Zod validation. */
export function sendValidationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "VALIDATION",
    message: error.issues[0]?.message ?? "Invalid request.",
    issues: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}