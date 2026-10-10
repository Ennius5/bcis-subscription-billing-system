import { type SQL, sql } from "drizzle-orm";
import { AUDIT_CATEGORY_PATTERNS, type AuditCategory, type AuditLogQuery, addDays } from "@bcis/shared";
import type { DbOrTx } from "./audit";

export interface AuditLogRow {
  id: string;
  occurredAt: Date;
  actor: { id: string; username: string; fullName: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  oldValues: unknown;
  newValues: unknown;
}

export interface AuditLogPage {
  items: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** LIKE needs its wildcards escaped when the pattern comes from our own constants. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function patternCondition(pattern: string): SQL {
  return pattern.endsWith(".") ? sql`al.action LIKE ${likePrefix(pattern)}` : sql`al.action = ${pattern}`;
}

/** SQL for "action is in this category"; "other" is everything no named category matches. */
export function categoryCondition(category: AuditCategory): SQL {
  if (category === "other") {
    const all = Object.values(AUDIT_CATEGORY_PATTERNS).flat().map(patternCondition);
    return sql`NOT (${sql.join(all, sql` OR `)})`;
  }
  return sql`(${sql.join(AUDIT_CATEGORY_PATTERNS[category].map(patternCondition), sql` OR `)})`;
}

/**
 * A timestamptz column within Manila calendar days from..to, written as a timestamp range so
 * an index on the column is usable (no function applied to the column).
 */
export function manilaDayRange(column: SQL, from?: string, to?: string): SQL {
  const parts: SQL[] = [];
  if (from) parts.push(sql`${column} >= (${from}::date::timestamp AT TIME ZONE 'Asia/Manila')`);
  if (to) parts.push(sql`${column} < (${addDays(to, 1)}::date::timestamp AT TIME ZONE 'Asia/Manila')`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

/** The audit log, newest first, read-only (spec 4.4: not editable through any screen). */
export async function listAuditLogs(db: DbOrTx, query: AuditLogQuery): Promise<AuditLogPage> {
  const where = sql.join(
    [
      manilaDayRange(sql`al.occurred_at`, query.from, query.to),
      query.actorUserId ? sql`al.actor_user_id = ${query.actorUserId}` : sql`TRUE`,
      query.category ? categoryCondition(query.category) : sql`TRUE`,
      query.action ? sql`al.action = ${query.action}` : sql`TRUE`,
      query.entityType ? sql`al.entity_type = ${query.entityType}` : sql`TRUE`,
      query.entityId ? sql`al.entity_id = ${query.entityId}` : sql`TRUE`,
    ],
    sql` AND `,
  );

  const total = await db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM audit_logs al WHERE ${where}`);
  const rows = await db.execute<{
    id: string;
    occurred_at: Date;
    actor_user_id: string | null;
    username: string | null;
    full_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    reason: string | null;
    old_values: unknown;
    new_values: unknown;
  }>(sql`
    SELECT al.id, al.occurred_at, al.actor_user_id, u.username, u.full_name, al.action, al.entity_type,
           al.entity_id, al.reason, al.old_values, al.new_values
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.actor_user_id
    WHERE ${where}
    ORDER BY al.occurred_at DESC, al.id DESC
    LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
  `);

  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      occurredAt: new Date(r.occurred_at),
      actor: r.actor_user_id ? { id: r.actor_user_id, username: r.username ?? "", fullName: r.full_name ?? "" } : null,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      reason: r.reason,
      oldValues: r.old_values,
      newValues: r.new_values,
    })),
    total: total.rows[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface AuditFilterOptions {
  users: Array<{ id: string; username: string; fullName: string; isActive: boolean }>;
  actions: string[];
  entityTypes: string[];
}

/** Choices for the log filters: every user, and the actions and entity types that occur. */
export async function getAuditFilterOptions(db: DbOrTx): Promise<AuditFilterOptions> {
  const users = await db.execute<{ id: string; username: string; full_name: string; is_active: boolean }>(
    sql`SELECT id, username, full_name, is_active FROM users ORDER BY is_active DESC, username`,
  );
  const actions = await db.execute<{ action: string }>(sql`SELECT DISTINCT action FROM audit_logs ORDER BY action`);
  const types = await db.execute<{ entity_type: string }>(sql`SELECT DISTINCT entity_type FROM audit_logs ORDER BY entity_type`);
  return {
    users: users.rows.map((u) => ({ id: u.id, username: u.username, fullName: u.full_name, isActive: u.is_active })),
    actions: actions.rows.map((a) => a.action),
    entityTypes: types.rows.map((t) => t.entity_type),
  };
}
