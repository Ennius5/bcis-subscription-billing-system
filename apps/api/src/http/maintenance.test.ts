import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { testConfig } from "../test/helpers";
import { MaintenanceBusyError } from "./maintenance";

let app: FastifyInstance;
let releaseSlow: () => void = () => undefined;

beforeAll(async () => {
  app = buildApp(testConfig());
  // Stands in for a payment that is still being posted when the restore starts.
  app.get("/test/slow", async () => {
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    return { done: true };
  });
  app.get("/test/fast", async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("maintenance mode", () => {
  it("waits for running requests, locks everyone else out, then reopens", async () => {
    const slow = app.inject({ method: "GET", url: "/test/slow" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it start

    let workStarted = false;
    const restore = app.maintenance.run(
      async () => {
        workStarted = true;
        const blocked = await app.inject({ method: "GET", url: "/test/fast" });
        const health = await app.inject({ method: "GET", url: "/health" });
        return { blocked, health };
      },
      { ownRequests: 0 },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(workStarted).toBe(false); // still waiting for the slow request
    const meanwhile = await app.inject({ method: "GET", url: "/test/fast" });
    expect(meanwhile.statusCode).toBe(503);
    expect(meanwhile.json().error).toBe("MAINTENANCE");

    releaseSlow();
    expect((await slow).statusCode).toBe(200);
    const { blocked, health } = await restore;
    expect(blocked.statusCode).toBe(503);
    expect(health.statusCode).toBe(200);

    expect(app.maintenance.isActive).toBe(false);
    expect((await app.inject({ method: "GET", url: "/test/fast" })).statusCode).toBe(200);
  });

  it("gives up if requests keep running, and reopens", async () => {
    const slow = app.inject({ method: "GET", url: "/test/slow" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(app.maintenance.run(async () => "never", { ownRequests: 0, waitMs: 200 })).rejects.toBeInstanceOf(
      MaintenanceBusyError,
    );
    expect(app.maintenance.isActive).toBe(false);
    releaseSlow();
    await slow;
  });

  it("refuses a second restore while one runs", async () => {
    let finish: () => void = () => undefined;
    const first = app.maintenance.run(() => new Promise<void>((resolve) => (finish = resolve)), { ownRequests: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(app.maintenance.run(async () => undefined, { ownRequests: 0 })).rejects.toBeInstanceOf(MaintenanceBusyError);
    finish();
    await first;
  });
});
