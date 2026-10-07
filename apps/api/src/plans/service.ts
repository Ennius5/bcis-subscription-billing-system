import { and, asc, eq, type SQL } from "drizzle-orm";
import {
  planAttributeProblem,
  type PlanCreateInput,
  type PlanUpdateInput,
  type ServiceTypeCode,
} from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { servicePlans, serviceTypes } from "../db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class PlanError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "CODE_TAKEN" | "INVALID_ATTRIBUTES",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  serviceType: string;
  priceCentavos: number;
  installationFeeCentavos: number;
  reconnectionFeeCentavos: number;
  description: string | null;
  speedMbps: number | null;
  channelCount: number | null;
  isActive: boolean;
};

const planColumns = {
  id: servicePlans.id,
  code: servicePlans.code,
  name: servicePlans.name,
  serviceType: serviceTypes.code,
  priceCentavos: servicePlans.priceCentavos,
  installationFeeCentavos: servicePlans.installationFeeCentavos,
  reconnectionFeeCentavos: servicePlans.reconnectionFeeCentavos,
  description: servicePlans.description,
  speedMbps: servicePlans.speedMbps,
  channelCount: servicePlans.channelCount,
  isActive: servicePlans.isActive,
};

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function fetchPlan(tx: Tx, id: string): Promise<PlanRow> {
  const [row] = await tx
    .select(planColumns)
    .from(servicePlans)
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(eq(servicePlans.id, id))
    .limit(1);
  if (!row) throw new PlanError("NOT_FOUND", 404, "Plan not found.");
  return row;
}

export async function listPlans(
  db: Db,
  opts: { includeInactive?: boolean; serviceType?: ServiceTypeCode } = {},
): Promise<PlanRow[]> {
  const filters: SQL[] = [];
  if (!opts.includeInactive) filters.push(eq(servicePlans.isActive, true));
  if (opts.serviceType) filters.push(eq(serviceTypes.code, opts.serviceType));

  return db
    .select(planColumns)
    .from(servicePlans)
    .innerJoin(serviceTypes, eq(servicePlans.serviceTypeId, serviceTypes.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(serviceTypes.code), asc(servicePlans.code));
}

export async function createPlan(
  db: Db,
  actorUserId: string,
  input: PlanCreateInput,
): Promise<PlanRow> {
  try {
    return await db.transaction(async (tx) => {
      const [type] = await tx
        .select({ id: serviceTypes.id })
        .from(serviceTypes)
        .where(eq(serviceTypes.code, input.serviceType))
        .limit(1);
      if (!type) throw new PlanError("NOT_FOUND", 404, "Service type not found.");

      const [created] = await tx
        .insert(servicePlans)
        .values({
          code: input.code,
          name: input.name,
          serviceTypeId: type.id,
          priceCentavos: input.priceCentavos,
          installationFeeCentavos: input.installationFeeCentavos,
          reconnectionFeeCentavos: input.reconnectionFeeCentavos,
          description: input.description ?? null,
          speedMbps: input.speedMbps ?? null,
          channelCount: input.channelCount ?? null,
        })
        .returning({ id: servicePlans.id });
      if (!created) throw new Error("Failed to create plan");

      const plan = await fetchPlan(tx, created.id);
      await writeAudit(tx, {
        actorUserId,
        action: "plan.create",
        entityType: "plan",
        entityId: plan.id,
        newValues: plan,
      });
      return plan;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new PlanError("CODE_TAKEN", 409, `Plan code "${input.code}" is already in use.`);
    }
    throw err;
  }
}

export async function updatePlan(
  db: Db,
  actorUserId: string,
  planId: string,
  input: PlanUpdateInput,
): Promise<PlanRow> {
  return db.transaction(async (tx) => {
    // Lock the row so two PCs cannot overwrite each other's edits.
    const [existing] = await tx
      .select()
      .from(servicePlans)
      .where(eq(servicePlans.id, planId))
      .for("update");
    if (!existing) throw new PlanError("NOT_FOUND", 404, "Plan not found.");

    const [type] = await tx
      .select({ code: serviceTypes.code })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, existing.serviceTypeId))
      .limit(1);
    if (!type) throw new Error("Plan has no service type");

    const { reason, ...fields } = input;

    const problem = planAttributeProblem(
      type.code as ServiceTypeCode,
      fields.speedMbps !== undefined ? fields.speedMbps : existing.speedMbps,
      fields.channelCount !== undefined ? fields.channelCount : existing.channelCount,
    );
    if (problem) throw new PlanError("INVALID_ATTRIBUTES", 422, problem.message);

    // Audit only the fields that were part of this change.
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      oldValues[key] = existing[key];
      newValues[key] = fields[key];
    }

    await tx
      .update(servicePlans)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(servicePlans.id, planId));

    await writeAudit(tx, {
      actorUserId,
      action: "plan.update",
      entityType: "plan",
      entityId: planId,
      reason: reason ?? null,
      oldValues,
      newValues,
    });

    return fetchPlan(tx, planId);
  });
}