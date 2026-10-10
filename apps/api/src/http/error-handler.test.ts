import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { testConfig } from "../test/helpers";
import { loggerOptions } from "./logging";

let app: FastifyInstance;
let logged: string[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding, done) {
    logged.push(chunk.toString());
    done();
  },
});

const SECRET_TOKEN = "super-secret-session-token";

beforeAll(async () => {
  app = buildApp(testConfig(), { logger: pino({ level: "info" }, capture) });
  // Routes that misbehave on purpose, the way a bug would.
  app.get("/test/boom", async () => {
    throw new Error("simulated bug in a service");
  });
  app.get("/test/db-down", async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  });
  app.post("/test/echo", async (request) => request.body);
  await app.ready();
});

beforeEach(() => {
  logged = [];
});

afterAll(async () => {
  await app.close();
});

describe("unexpected errors", () => {
  it("answer 500 with a plain message and a reference that matches the log", async () => {
    const res = await app.inject({ method: "GET", url: "/test/boom" });
    expect(res.statusCode).toBe(500);

    const body = res.json<{ error: string; message: string; reference: string }>();
    expect(body.error).toBe("INTERNAL");
    expect(body.reference).toMatch(/^[0-9a-f]{10}$/);
    expect(body.reference).toBe(res.headers["x-request-id"]);
    expect(body.message).toContain(body.reference);
    // The user never sees the technical detail...
    expect(res.body).not.toContain("simulated bug");
    expect(res.body).not.toContain("error-handler.test");

    // ...the log has it, tagged with the same reference.
    const line = logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "unhandled error");
    expect(line?.reqId).toBe(body.reference);
    expect(JSON.stringify(line)).toContain("simulated bug in a service");
    expect(JSON.stringify(line)).toContain("stack");
  });

  it("report an unreachable database as 503, not as a bug", async () => {
    const res = await app.inject({ method: "GET", url: "/test/db-down" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("DATABASE_UNAVAILABLE");
    expect(res.body).not.toContain("5432");
  });

  it("never log the session token", async () => {
    await app.inject({ method: "GET", url: "/test/boom", headers: { authorization: `Bearer ${SECRET_TOKEN}` } });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET_TOKEN);
  });
});

describe("malformed requests", () => {
  it("broken JSON gets a friendly 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("The request was not understood. Please try again.");
  });

  it("unknown endpoints get a JSON 404", async () => {
    const res = await app.inject({ method: "GET", url: "/no/such/thing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_FOUND");
  });
});

describe("request ids", () => {
  it("every reply carries its own id", async () => {
    const a = await app.inject({ method: "GET", url: "/health" });
    const b = await app.inject({ method: "GET", url: "/health" });
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f]{10}$/);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});

describe("logger options", () => {
  it("are silent in tests and write daily files otherwise", () => {
    expect(loggerOptions(testConfig())).toEqual({ level: "silent" });
    const options = loggerOptions(testConfig({ NODE_ENV: "production" }));
    expect(JSON.stringify(options)).toContain("pino-roll");
    expect(JSON.stringify(options)).toContain("req.headers.authorization");
  });
});
