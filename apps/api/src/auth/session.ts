import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// Tokens are 256 bits of randomness, so a fast hash is enough here.
// (Passwords are different: they need argon2.)
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ABSOLUTE_TIMEOUT_MS),
  });
  return token;
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  username: string;
  fullName: string;
}

export async function findActiveSession(
  db: Db,
  token: string,
): Promise<ActiveSession | null> {
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MS);

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      username: users.username,
      fullName: users.fullName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.lastActivityAt, idleCutoff),
        eq(users.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  await db
    .update(sessions)
    .set({ lastActivityAt: now })
    .where(eq(sessions.id, row.sessionId));
  return row;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}