import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp({
      API_HOST: "127.0.0.1",
      API_PORT: 3000,
      DATABASE_URL: "postgresql://unused",
      NODE_ENV: "test",
    });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});