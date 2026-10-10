import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Runs pg_dump / pg_restore without a shell, so no argument is ever interpreted as a
 * command. The connection comes from DATABASE_URL through the standard PG* variables:
 * the password never appears on the command line (visible to every process on the PC)
 * nor in any message we produce.
 */

export type PgTool = "pg_dump" | "pg_restore";

const TEN_MINUTES = 10 * 60 * 1000;

export class PgToolError extends Error {}

/** PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE from a postgres:// URL. */
export function pgEnvironment(databaseUrl: string, database?: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: url.hostname || "localhost",
    PGPORT: url.port || "5432",
    PGDATABASE: database ?? decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  return env;
}

export function toolPath(binDir: string, tool: PgTool): string {
  if (!binDir) return tool;
  return path.join(binDir, process.platform === "win32" ? `${tool}.exe` : tool);
}

/** Runs the tool and returns its standard output. Fails with a message safe to store and show. */
export function runPgTool(
  binDir: string,
  tool: PgTool,
  args: readonly string[],
  databaseUrl: string,
  database?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      toolPath(binDir, tool),
      args,
      {
        env: { ...process.env, ...pgEnvironment(databaseUrl, database) },
        timeout: TEN_MINUTES,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return reject(new PgToolError(`${tool} was not found. Set PG_BIN_DIR to PostgreSQL's bin folder.`));
        }
        // The first stderr line is the useful one ("pg_dump: error: connection ... failed").
        const detail = stderr.split(/\r?\n/).find((l) => l.trim() !== "") ?? err.message;
        reject(new PgToolError(`${tool} failed: ${detail.slice(0, 300)}`));
      },
    );
  });
}
