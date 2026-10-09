import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { testConfig } from "./test/helpers";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp(testConfig());

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});