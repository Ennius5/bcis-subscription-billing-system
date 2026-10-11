// Production build of the API: `pnpm --filter ./apps/api build`.
//
// Bundles the TypeScript (including the @bcis/shared source, which Node cannot run as is)
// into plain JavaScript in dist/. Every npm dependency stays external and is loaded from
// node_modules at run time: pino starts its log-file transport by package name in a worker
// thread, @node-rs/argon2 is a native module, and pdfmake reads its font files from its folder.
import { readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@bcis/"));

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: {
    server: "src/server.ts", // the API: node dist/server.js
    backup: "src/backup/cli.ts", // scheduled backup: node dist/backup.js
    migrate: "src/db/migrate.ts", // node dist/migrate.js
  },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outdir: "dist",
  external,
  sourcemap: true, // stack traces in the log point at the TypeScript lines
  logLevel: "info",
});
