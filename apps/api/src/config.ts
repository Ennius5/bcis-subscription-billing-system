import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Folder for uploaded payment proof images; resolved to an absolute path. */
  PROOF_STORAGE_DIR: z
    .string()
    .min(1)
    .default("attachments/payment-proofs")
    .transform((dir) => path.resolve(dir)),
  /** Folder holding one sub-folder per backup; resolved to an absolute path. */
  BACKUP_DIR: z
    .string()
    .min(1)
    .default("backups")
    .transform((dir) => path.resolve(dir)),
  /** Folder of pg_dump/pg_restore, e.g. C:\Program Files\PostgreSQL\18\bin. Empty = find them on PATH. */
  PG_BIN_DIR: z.string().default(""),
  /** Folder for the daily API log files; resolved to an absolute path. */
  LOG_DIR: z
    .string()
    .min(1)
    .default("logs")
    .transform((dir) => path.resolve(dir)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}