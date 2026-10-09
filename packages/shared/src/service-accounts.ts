import { z } from "zod";
import { MAX_PLAN_CENTAVOS, SERVICE_TYPE_CODES } from "./plans";
import { BILLING_DAY_MAX, BILLING_DAY_MIN } from "./subscribers";

export const SERVICE_ACCOUNT_STATUSES = ["pending", "active", "suspended", "terminated"] as const;
export type ServiceAccountStatus = (typeof SERVICE_ACCOUNT_STATUSES)[number];

// The generic status change. Suspending and reconnecting are their own actions (Phase 7),
// with a suspension record and a reconnection workflow, so they are not offered here.
const ALLOWED_TRANSITIONS: Record<ServiceAccountStatus, readonly ServiceAccountStatus[]> = {
  pending: ["active", "terminated"], // installed, or cancelled before installation
  active: ["terminated"],
  suspended: ["terminated"],
  terminated: [],
};

/** Domain rule: which status a service account may move to next through a status change. */
export function allowedServiceTransitions(from: ServiceAccountStatus): readonly ServiceAccountStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Returns a user-facing message when the change is not allowed, or null when it is. */
export function serviceStatusChangeProblem(
  from: ServiceAccountStatus,
  to: ServiceAccountStatus,
): string | null {
  if (from === to) return `The service account is already ${to}.`;
  if (from === "active" && to === "suspended") return "Use Suspend, which records the reason and approval.";
  if (from === "suspended" && to === "active") return "A suspended service is restored through a reconnection.";
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return `A ${from} service account cannot be changed to ${to}.`;
  }
  return null;
}

const reason = z.string().trim().max(200).optional();
const requiredReason = z.string().trim().min(3, "A reason is required.").max(200);
const rateCentavos = z.number().int().min(0, "Rate cannot be negative.").max(MAX_PLAN_CENTAVOS);
/** Calendar date as "YYYY-MM-DD". Omitted means today on the server. */
const isoDate = z.iso.date({ message: "Enter a valid date (YYYY-MM-DD)." });
const billingDay = z
  .number()
  .int()
  .min(BILLING_DAY_MIN, "Billing day must be between 1 and 28.")
  .max(BILLING_DAY_MAX, "Billing day must be between 1 and 28.");

const hasChange = (v: Record<string, unknown>) => Object.keys(v).some((k) => k !== "reason");
const noChangeMessage = { message: "Provide at least one field to change." };

/* ------------------------------- Create ------------------------------- */

// The rate is not an input: it is copied from the plan's price when the account is created.
export const serviceAccountCreateSchema = z.object({
  planId: z.uuid(),
  installationAddressId: z.uuid(),
  /** Defaults to the subscriber's billing day. */
  billingDay: billingDay.optional(),
  /** Optional override; empty means the subscriber's collector applies. */
  assignedCollectorId: z.uuid().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type ServiceAccountCreateInput = z.infer<typeof serviceAccountCreateSchema>;

/* ------------------------------- Update ------------------------------- */

// Plan, rate, status and collector have their own schemas, so they are rejected here.
export const serviceAccountUpdateSchema = z
  .strictObject({
    installationAddressId: z.uuid().optional(),
    billingDay: billingDay.optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type ServiceAccountUpdateInput = z.infer<typeof serviceAccountUpdateSchema>;

/* ---------------------------- Status change ---------------------------- */

export const serviceStatusChangeSchema = z
  .strictObject({
    status: z.enum(SERVICE_ACCOUNT_STATUSES),
    reason: requiredReason,
    effectiveDate: isoDate.optional(),
    /** Only when activating; defaults to the activation (effective) date. */
    billingStartDate: isoDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.billingStartDate !== undefined && v.status !== "active") {
      ctx.addIssue({
        code: "custom",
        message: "A billing start date only applies when activating.",
        path: ["billingStartDate"],
      });
    }
    // ISO dates compare correctly as strings.
    if (v.billingStartDate && v.effectiveDate && v.billingStartDate < v.effectiveDate) {
      ctx.addIssue({
        code: "custom",
        message: "Billing cannot start before the activation date.",
        path: ["billingStartDate"],
      });
    }
  });
export type ServiceStatusChangeInput = z.infer<typeof serviceStatusChangeSchema>;

/* ----------------------------- Rate change ----------------------------- */

export const serviceRateChangeSchema = z.strictObject({
  rateCentavos,
  reason: requiredReason,
  effectiveDate: isoDate.optional(),
});
export type ServiceRateChangeInput = z.infer<typeof serviceRateChangeSchema>;

/* ----------------------------- Plan change ----------------------------- */

export const servicePlanChangeSchema = z.strictObject({
  planId: z.uuid(),
  /** Defaults to the new plan's current price. */
  rateCentavos: rateCentavos.optional(),
  reason: requiredReason,
  effectiveDate: isoDate.optional(),
});
export type ServicePlanChangeInput = z.infer<typeof servicePlanChangeSchema>;

/* ------------------------------ List query ------------------------------ */

export const SERVICE_ACCOUNT_PAGE_SIZE_DEFAULT = 25;
export const SERVICE_ACCOUNT_PAGE_SIZE_MAX = 100;

// Query-string values arrive as text, so numbers are coerced.
// A blank search box is treated the same as no search.
export const serviceAccountListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(SERVICE_ACCOUNT_PAGE_SIZE_MAX)
    .default(SERVICE_ACCOUNT_PAGE_SIZE_DEFAULT),
  subscriberId: z.uuid().optional(),
  status: z.enum(SERVICE_ACCOUNT_STATUSES).optional(),
  planId: z.uuid().optional(),
  serviceType: z.enum(SERVICE_TYPE_CODES).optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => (s === "" ? undefined : s)),
});
export type ServiceAccountListQuery = z.infer<typeof serviceAccountListQuerySchema>;

/* --------------------------- Collector change --------------------------- */

// Required so the intent is explicit. null returns the account to the subscriber's collector.
export const serviceCollectorChangeSchema = z.strictObject({
  assignedCollectorId: z.uuid().nullable(),
  reason,
});
export type ServiceCollectorChangeInput = z.infer<typeof serviceCollectorChangeSchema>;
