import { sql } from "drizzle-orm";
import { AUDIT_CATEGORIES, type AuditCategory, type UserActivityQuery, auditCategory } from "@bcis/shared";
import type { DbOrTx } from "../audit/audit";
import { manilaDayRange } from "../audit/log";

export interface UserActivityRow {
  /** Null for actions recorded without a user. */
  userId: string | null;
  username: string;
  fullName: string;
  roles: string | null;
  isActive: boolean;
  /** Successful sign-ins (sessions started) in the range. */
  loginCount: number;
  lastLoginAt: Date | null;
  actionCount: number;
  byCategory: Record<AuditCategory, number>;
  lastActionAt: Date | null;
}

export interface ActionCountRow {
  action: string;
  category: AuditCategory;
  count: number;
  userCount: number;
}

export interface UserActivityReport {
  from: string;
  to: string;
  users: UserActivityRow[];
  actions: ActionCountRow[];
  totals: { loginCount: number; actionCount: number; byCategory: Record<AuditCategory, number> };
}

const zeroCategories = () => Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c, 0])) as Record<AuditCategory, number>;

/**
 * Who did what over a date range (spec 3.11 user activity): sign-ins from the sessions table
 * and audited actions grouped by area of work. Lists every active user (even if idle) and any
 * inactive user who did something in the range. Dates are Asia/Manila calendar days.
 */
export async function getUserActivity(db: DbOrTx, query: UserActivityQuery): Promise<UserActivityReport> {
  const actionInRange = manilaDayRange(sql`al.occurred_at`, query.from, query.to);
  const loginInRange = manilaDayRange(sql`se.created_at`, query.from, query.to);

  const users = await db.execute<{
    id: string;
    username: string;
    full_name: string;
    is_active: boolean;
    last_login_at: Date | null;
    roles: string | null;
    logins: number;
  }>(sql`
    SELECT u.id, u.username, u.full_name, u.is_active, u.last_login_at,
      (SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = u.id) AS roles,
      (SELECT count(*) FROM sessions se WHERE se.user_id = u.id AND ${loginInRange})::int AS logins
    FROM users u
    ORDER BY u.username
  `);

  const actions = await db.execute<{ actor_user_id: string | null; action: string; count: number; last_at: Date }>(sql`
    SELECT al.actor_user_id, al.action, count(*)::int AS count, max(al.occurred_at) AS last_at
    FROM audit_logs al
    WHERE ${actionInRange}
    GROUP BY al.actor_user_id, al.action
  `);

  const rows = new Map<string | null, UserActivityRow>();
  for (const u of users.rows) {
    rows.set(u.id, {
      userId: u.id,
      username: u.username,
      fullName: u.full_name,
      roles: u.roles,
      isActive: u.is_active,
      loginCount: u.logins,
      lastLoginAt: u.last_login_at ? new Date(u.last_login_at) : null,
      actionCount: 0,
      byCategory: zeroCategories(),
      lastActionAt: null,
    });
  }

  const byAction = new Map<string, ActionCountRow>();
  const totals = { loginCount: 0, actionCount: 0, byCategory: zeroCategories() };
  for (const a of actions.rows) {
    let row = rows.get(a.actor_user_id);
    if (!row) {
      row = {
        userId: null,
        username: "(no user)",
        fullName: "Recorded without a signed-in user",
        roles: null,
        isActive: false,
        loginCount: 0,
        lastLoginAt: null,
        actionCount: 0,
        byCategory: zeroCategories(),
        lastActionAt: null,
      };
      rows.set(a.actor_user_id, row);
    }
    const category = auditCategory(a.action);
    row.actionCount += a.count;
    row.byCategory[category] += a.count;
    const lastAt = new Date(a.last_at);
    if (!row.lastActionAt || lastAt > row.lastActionAt) row.lastActionAt = lastAt;
    totals.actionCount += a.count;
    totals.byCategory[category] += a.count;

    const line = byAction.get(a.action) ?? { action: a.action, category, count: 0, userCount: 0 };
    line.count += a.count;
    line.userCount += 1;
    byAction.set(a.action, line);
  }

  const listed = [...rows.values()].filter((r) => r.isActive || r.actionCount > 0 || r.loginCount > 0);
  totals.loginCount = listed.reduce((t, r) => t + r.loginCount, 0);
  return {
    from: query.from,
    to: query.to,
    users: listed.toSorted((a, b) => b.actionCount - a.actionCount || a.username.localeCompare(b.username)),
    actions: [...byAction.values()].toSorted((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    totals,
  };
}
