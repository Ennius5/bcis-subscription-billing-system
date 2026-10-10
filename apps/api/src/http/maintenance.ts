import type { FastifyInstance, FastifyRequest } from "fastify";

/** Health checks still answer during a restore, so the desktop can show "server: connected". */
const ALWAYS_OPEN = new Set(["/health", "/health/db"]);

const WAIT_STEP_MS = 100;

export class MaintenanceBusyError extends Error {}

/**
 * Maintenance mode for a restore (Phase 9 decision 6). While active, every request except
 * the health checks gets 503 MAINTENANCE, so nobody posts a payment into a database that
 * is about to be replaced. Before switching on, it waits for requests already running to
 * finish (the restore request itself excepted).
 *
 * In-process only: one API server serves all three PCs (spec 2.1).
 */
export class MaintenanceGate {
  private active = false;
  private inFlight = 0;
  private readonly counted = new WeakSet<FastifyRequest>();

  get isActive(): boolean {
    return this.active;
  }

  register(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      if (this.active && !ALWAYS_OPEN.has(request.routeOptions.url ?? "")) {
        return reply.code(503).send({
          error: "MAINTENANCE",
          message: "The system is being restored from a backup. Please wait a few minutes, then sign in again.",
        });
      }
      this.counted.add(request);
      this.inFlight += 1;
    });
    app.addHook("onResponse", async (request) => {
      if (this.counted.delete(request)) this.inFlight -= 1;
    });
  }

  /**
   * Runs `work` with everyone else locked out. `ownRequests` is how many in-flight
   * requests belong to the caller (1 when called from the restore route, 0 from a script).
   */
  async run<T>(work: () => Promise<T>, options: { ownRequests: number; waitMs?: number }): Promise<T> {
    if (this.active) throw new MaintenanceBusyError("A restore is already running.");
    this.active = true;
    try {
      const deadline = Date.now() + (options.waitMs ?? 30_000);
      while (this.inFlight > options.ownRequests) {
        if (Date.now() > deadline) {
          throw new MaintenanceBusyError("Other requests are still running. Try the restore again in a minute.");
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
      }
      return await work();
    } finally {
      this.active = false;
    }
  }
}
