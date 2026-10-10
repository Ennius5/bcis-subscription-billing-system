import { z } from "zod";

export const SERVICE_TYPE_CODES = ["internet", "cable", "combo"] as const;
export type ServiceTypeCode = (typeof SERVICE_TYPE_CODES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceTypeCode, string> = {
  internet: "Internet",
  cable: "Cable",
  combo: "Combo",
};

/** Upper bound for any single plan amount: P1,000,000 expressed in centavos. */
export const MAX_PLAN_CENTAVOS = 100_000_000;

/** Domain rule: internet plans have a speed, cable plans have channels, combo may have both. */
export function planAttributeProblem(
  type: ServiceTypeCode,
  speedMbps: number | null | undefined,
  channelCount: number | null | undefined,
): { field: "speedMbps" | "channelCount"; message: string } | null {
  if (type === "internet" && channelCount != null) {
    return { field: "channelCount", message: "Internet plans cannot have a channel count." };
  }
  if (type === "cable" && speedMbps != null) {
    return { field: "speedMbps", message: "Cable plans cannot have a speed." };
  }
  return null;
}

const centavos = z.number().int().min(0).max(MAX_PLAN_CENTAVOS);

export const planCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{2,20}$/, "Code must be 2-20 letters, digits or hyphens.")
      .toUpperCase(),
    name: z.string().trim().min(1, "Name is required.").max(100),
    serviceType: z.enum(SERVICE_TYPE_CODES),
    priceCentavos: centavos,
    installationFeeCentavos: centavos.default(0),
    reconnectionFeeCentavos: centavos.default(0),
    description: z.string().trim().max(500).nullish(),
    speedMbps: z.number().int().positive().max(10_000).nullish(),
    channelCount: z.number().int().positive().max(1_000).nullish(),
  })
  .superRefine((plan, ctx) => {
    const problem = planAttributeProblem(plan.serviceType, plan.speedMbps, plan.channelCount);
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem.message, path: [problem.field] });
    }
  });

export type PlanCreateInput = z.infer<typeof planCreateSchema>;

export const planUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1, "Name is required.").max(100).optional(),
    priceCentavos: centavos.optional(),
    installationFeeCentavos: centavos.optional(),
    reconnectionFeeCentavos: centavos.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    speedMbps: z.number().int().positive().max(10_000).nullable().optional(),
    channelCount: z.number().int().positive().max(1_000).nullable().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "reason"), {
    message: "Provide at least one field to change.",
  });

export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;