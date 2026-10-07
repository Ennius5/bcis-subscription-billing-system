import type { Db } from "./client";

/** The handle passed to db.transaction callbacks. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Returns the violated constraint name for a unique violation, or null for any other error. */
export function violatedConstraint(err: unknown): string | null {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  } | null;
  if (e?.code === "23505") return e.constraint ?? "";
  if (e?.cause?.code === "23505") return e.cause.constraint ?? "";
  return null;
}

/** Only the fields whose value actually differs from the stored row. */
export function changedFields(existing: Record<string, unknown>, fields: Record<string, unknown>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== existing[key]) {
      oldValues[key] = existing[key];
      newValues[key] = value;
    }
  }
  return { oldValues, newValues };
}