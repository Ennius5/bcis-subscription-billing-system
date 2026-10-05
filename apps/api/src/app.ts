import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config";

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "bcis-api",
    time: new Date().toISOString(),
  }));

  return app;
}