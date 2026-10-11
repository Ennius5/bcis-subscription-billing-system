import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { testConfig } from "./test/helpers";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp(testConfig());

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    // The desktop app compares this with its own version (sign-in page warning).
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(res.json().version).toBe(pkg.version);
    await app.close();
  });
});