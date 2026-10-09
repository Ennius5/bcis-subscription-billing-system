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