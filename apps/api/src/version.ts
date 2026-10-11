import { readFileSync } from "node:fs";

/**
 * The API's version, from apps/api/package.json. The relative path is the same from src/ (dev,
 * tests) and from dist/ (the production bundle). /health reports it so the desktop app can warn
 * when the server was not updated along with the installer.
 */
export const API_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
