import type { Db } from "../db/client";
import { auditLogs } from "../db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Either the plain database or a transaction handle. */
export type DbOrTx = Db | Tx;

export interface AuditEntry {
  actorUserId?: string | null;
  action: string; // e.g. "payment.reverse"
  entityType: string; // e.g. "payment"
  entityId?: string | null;
  reason?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "tokenhash",
  "secret",
]);

/** Recursively replace sensitive values so they never reach the audit log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Append one audit record. Pass the SAME transaction handle as the
 * financial mutation so both commit or roll back together.
 */
export async function writeAudit(
  executor: DbOrTx,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    reason: entry.reason ?? null,
    oldValues: entry.oldValues ? redact(entry.oldValues) : null,
    newValues: entry.newValues ? redact(entry.newValues) : null,
  });
}