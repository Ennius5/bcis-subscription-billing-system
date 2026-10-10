import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FastifyServerOptions } from "fastify";
import type { Config } from "../config";

/**
 * Never logged: the session token travels in the Authorization header. Request and
 * response bodies (passwords, GCash details) are not logged at all by default.
 */
const REDACT = ["req.headers.authorization", "req.headers.cookie"];

/** Daily files kept besides today's (Phase 9 decision 8). */
export const LOG_RETENTION_DAYS = 30;

/**
 * A short random id for every request. It goes into every log line of that request and,
 * on an unexpected error, into the message the user sees, so the two can be matched.
 * Random rather than Fastify's counter, which restarts at req-1 after every restart.
 */
export function newRequestId(): string {
  return randomBytes(5).toString("hex");
}

/** Console plus one file per day in LOG_DIR (api.2026-10-11.log), old files pruned. */
export function loggerOptions(config: Config): FastifyServerOptions["logger"] {
  if (config.NODE_ENV === "test") return { level: "silent" };
  return {
    level: config.LOG_LEVEL,
    redact: REDACT,
    transport: {
      targets: [
        { target: "pino/file", level: config.LOG_LEVEL, options: { destination: 1 } },
        {
          target: "pino-roll",
          level: config.LOG_LEVEL,
          options: {
            file: path.join(config.LOG_DIR, "api"),
            frequency: "daily",
            dateFormat: "yyyy-MM-dd",
            mkdir: true,
            limit: { count: LOG_RETENTION_DAYS, removeOtherLogFiles: true },
          },
        },
      ],
    },
  };
}
