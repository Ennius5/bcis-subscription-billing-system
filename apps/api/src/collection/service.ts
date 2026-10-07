import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  AreaCreateInput,
  AreaUpdateInput,
  CollectorCreateInput,
  CollectorUpdateInput,
} from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { collectionAreas, collectors, users } from "../db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class CollectionError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "CODE_TAKEN" | "USER_NOT_FOUND" | "USER_ALREADY_LINKED",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Returns the violated constraint name for a unique violation, or null for any other error. */
function violatedConstraint(err: unknown): string | null {
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
function changedFields(existing: Record<string, unknown>, fields: Record<string, unknown>) {
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

/* ------------------------------ Areas ------------------------------ */

export type AreaRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
};

const areaColumns = {
  id: collectionAreas.id,
  code: collectionAreas.code,
  name: collectionAreas.name,
  description: collectionAreas.description,
  isActive: collectionAreas.isActive,
};

async function fetchArea(tx: Tx, id: string): Promise<AreaRow> {
  const [row] = await tx
    .select(areaColumns)
    .from(collectionAreas)
    .where(eq(collectionAreas.id, id))
    .limit(1);
  if (!row) throw new CollectionError("NOT_FOUND", 404, "Collection area not found.");
  return row;
}

export async function listAreas(
  db: Db,
  opts: { includeInactive?: boolean } = {},
): Promise<AreaRow[]> {
  return db
    .select(areaColumns)
    .from(collectionAreas)
    .where(opts.includeInactive ? undefined : eq(collectionAreas.isActive, true))
    .orderBy(asc(collectionAreas.code));
}

export async function createArea(
  db: Db,
  actorUserId: string,
  input: AreaCreateInput,
): Promise<AreaRow> {
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(collectionAreas)
        .values({
          code: input.code,
          name: input.name,
          description: input.description ?? null,
        })
        .returning({ id: collectionAreas.id });
      if (!created) throw new Error("Failed to create collection area");

      const area = await fetchArea(tx, created.id);
      await writeAudit(tx, {
        actorUserId,
        action: "collection_area.create",
        entityType: "collection_area",
        entityId: area.id,
        newValues: area,
      });
      return area;
    });
  } catch (err) {
    if (violatedConstraint(err) !== null) {
      throw new CollectionError("CODE_TAKEN", 409, `Area code "${input.code}" is already in use.`);
    }
    throw err;
  }
}

export async function updateArea(
  db: Db,
  actorUserId: string,
  areaId: string,
  input: AreaUpdateInput,
): Promise<AreaRow> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(collectionAreas)
      .where(eq(collectionAreas.id, areaId))
      .for("update");
    if (!existing) throw new CollectionError("NOT_FOUND", 404, "Collection area not found.");

    const { reason, ...fields } = input;
    const { oldValues, newValues } = changedFields(existing, fields);
    if (Object.keys(newValues).length === 0) return fetchArea(tx, areaId);

    await tx
      .update(collectionAreas)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(collectionAreas.id, areaId));

    await writeAudit(tx, {
      actorUserId,
      action: "collection_area.update",
      entityType: "collection_area",
      entityId: areaId,
      reason: reason ?? null,
      oldValues,
      newValues,
    });

    return fetchArea(tx, areaId);
  });
}

/* ---------------------------- Collectors ---------------------------- */

export type CollectorRow = {
  id: string;
  code: string;
  fullName: string;
  contactNumber: string | null;
  userId: string | null;
  username: string | null;
  isActive: boolean;
};

const collectorColumns = {
  id: collectors.id,
  code: collectors.code,
  fullName: collectors.fullName,
  contactNumber: collectors.contactNumber,
  userId: collectors.userId,
  username: users.username,
  isActive: collectors.isActive,
};

async function fetchCollector(tx: Tx, id: string): Promise<CollectorRow> {
  const [row] = await tx
    .select(collectorColumns)
    .from(collectors)
    .leftJoin(users, eq(collectors.userId, users.id))
    .where(eq(collectors.id, id))
    .limit(1);
  if (!row) throw new CollectionError("NOT_FOUND", 404, "Collector not found.");
  return row;
}

async function assertUserExists(tx: Tx, userId: string): Promise<void> {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new CollectionError("USER_NOT_FOUND", 422, "The selected user does not exist.");
}

function rethrowCollectorConflict(err: unknown): never {
  const constraint = violatedConstraint(err);
  if (constraint === "collectors_user_id_unique") {
    throw new CollectionError("USER_ALREADY_LINKED", 409, "That user is already linked to another collector.");
  }
  if (constraint === "collectors_code_unique") {
    throw new CollectionError("CODE_TAKEN", 409, "Collector code is already in use.");
  }
  throw err;
}

export async function listCollectors(
  db: Db,
  opts: { includeInactive?: boolean } = {},
): Promise<CollectorRow[]> {
  return db
    .select(collectorColumns)
    .from(collectors)
    .leftJoin(users, eq(collectors.userId, users.id))
    .where(opts.includeInactive ? undefined : eq(collectors.isActive, true))
    .orderBy(asc(collectors.code));
}

export async function createCollector(
  db: Db,
  actorUserId: string,
  input: CollectorCreateInput,
): Promise<CollectorRow> {
  try {
    return await db.transaction(async (tx) => {
      if (input.userId) await assertUserExists(tx, input.userId);

      const [created] = await tx
        .insert(collectors)
        .values({
          code: input.code,
          fullName: input.fullName,
          contactNumber: input.contactNumber ?? null,
          userId: input.userId ?? null,
        })
        .returning({ id: collectors.id });
      if (!created) throw new Error("Failed to create collector");

      const collector = await fetchCollector(tx, created.id);
      await writeAudit(tx, {
        actorUserId,
        action: "collector.create",
        entityType: "collector",
        entityId: collector.id,
        newValues: collector,
      });
      return collector;
    });
  } catch (err) {
    return rethrowCollectorConflict(err);
  }
}

export async function updateCollector(
  db: Db,
  actorUserId: string,
  collectorId: string,
  input: CollectorUpdateInput,
): Promise<CollectorRow> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(collectors)
        .where(eq(collectors.id, collectorId))
        .for("update");
      if (!existing) throw new CollectionError("NOT_FOUND", 404, "Collector not found.");

      const { reason, ...fields } = input;
      const { oldValues, newValues } = changedFields(existing, fields);
      if (Object.keys(newValues).length === 0) return fetchCollector(tx, collectorId);

      if (fields.userId && fields.userId !== existing.userId) {
        await assertUserExists(tx, fields.userId);
      }

      await tx
        .update(collectors)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(collectors.id, collectorId));

      await writeAudit(tx, {
        actorUserId,
        action: "collector.update",
        entityType: "collector",
        entityId: collectorId,
        reason: reason ?? null,
        oldValues,
        newValues,
      });

      return fetchCollector(tx, collectorId);
    });
  } catch (err) {
    if (err instanceof CollectionError) throw err;
    return rethrowCollectorConflict(err);
  }
}

/* ------------------------ Login picker (users) ------------------------ */

export type AvailableUserRow = {
  id: string;
  username: string;
  fullName: string;
};

/** Active users who are not linked to any collector, active or inactive. */
export async function listAvailableUsers(db: Db): Promise<AvailableUserRow[]> {
  return db
    .select({ id: users.id, username: users.username, fullName: users.fullName })
    .from(users)
    .leftJoin(collectors, eq(collectors.userId, users.id))
    .where(and(eq(users.isActive, true), isNull(collectors.id)))
    .orderBy(asc(users.username));
}