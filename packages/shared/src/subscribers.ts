import { z } from "zod";

export const SUBSCRIBER_STATUSES = ["active", "inactive", "terminated", "archived"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export const CONTACT_TYPES = ["mobile", "landline", "email", "other"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const BILLING_DAY_MIN = 1;
export const BILLING_DAY_MAX = 28;

/** Most active contacts a subscriber can have. Deactivated contacts do not count. */
export const SUBSCRIBER_CONTACTS_MAX = 5;

const ALLOWED_TRANSITIONS: Record<SubscriberStatus, readonly SubscriberStatus[]> = {
  active: ["inactive", "terminated"],
  inactive: ["active", "terminated"],
  terminated: ["archived"],
  archived: [],
};

/** Domain rule: which status a subscriber may move to next. */
export function allowedStatusTransitions(from: SubscriberStatus): readonly SubscriberStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Returns a user-facing message when the change is not allowed, or null when it is. */
export function statusChangeProblem(from: SubscriberStatus, to: SubscriberStatus): string | null {
  if (from === to) return `The subscriber is already ${to}.`;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return `A ${from} subscriber cannot be changed to ${to}.`;
  }
  return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS = /^[0-9+()\-\s]+$/;

/** Returns a user-facing message when the value does not suit the type, or null when it does. */
export function contactValueProblem(type: ContactType, rawValue: string): string | null {
  const value = rawValue.trim();
  if (value === "") return "Contact value is required.";
  if (type === "email") {
    return EMAIL_PATTERN.test(value) ? null : "Enter a valid email address.";
  }
  if (type === "mobile" || type === "landline") {
    if (!PHONE_CHARS.test(value)) {
      return "Phone numbers can only contain digits, spaces, + ( ) and -.";
    }
    const digits = value.replace(/\D/g, "").length;
    if (digits < 7 || digits > 15) return "Phone numbers must have 7 to 15 digits.";
  }
  return null;
}

const reason = z.string().trim().max(200).optional();

const hasChange = (v: Record<string, unknown>) => Object.keys(v).some((k) => k !== "reason");
const noChangeMessage = { message: "Provide at least one field to change." };

const billingDay = z
  .number()
  .int()
  .min(BILLING_DAY_MIN, "Billing day must be between 1 and 28.")
  .max(BILLING_DAY_MAX, "Billing day must be between 1 and 28.");

/* ----------------------------- Addresses ----------------------------- */

const addressFields = {
  label: z.string().trim().max(50).nullish(),
  line1: z.string().trim().min(1, "Street or purok is required.").max(200),
  barangay: z.string().trim().min(1, "Barangay is required.").max(100),
  city: z.string().trim().min(1, "City or municipality is required.").max(100),
  province: z.string().trim().max(100).nullish(),
  landmark: z.string().trim().max(200).nullish(),
};

/** The address typed on the New Subscriber form (it becomes the primary address). */
export const addressInputSchema = z.object(addressFields);
export type AddressInput = z.infer<typeof addressInputSchema>;

/** An additional address for an existing subscriber. */
export const addressCreateSchema = z.object({
  ...addressFields,
  isPrimary: z.boolean().optional(),
});
export type AddressCreateInput = z.infer<typeof addressCreateSchema>;

export const addressUpdateSchema = z
  .strictObject({
    label: z.string().trim().max(50).nullable().optional(),
    line1: z.string().trim().min(1, "Street or purok is required.").max(200).optional(),
    barangay: z.string().trim().min(1, "Barangay is required.").max(100).optional(),
    city: z.string().trim().min(1, "City or municipality is required.").max(100).optional(),
    province: z.string().trim().max(100).nullable().optional(),
    landmark: z.string().trim().max(200).nullable().optional(),
    isPrimary: z.literal(true).optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type AddressUpdateInput = z.infer<typeof addressUpdateSchema>;

/* ------------------------------ Contacts ------------------------------ */

export const contactInputSchema = z
  .object({
    type: z.enum(CONTACT_TYPES),
    value: z.string().trim().min(1, "Contact value is required.").max(100),
    contactName: z.string().trim().max(100).nullish(),
    isPrimary: z.boolean().optional(),
  })
  .superRefine((contact, ctx) => {
    const problem = contactValueProblem(contact.type, contact.value);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
  });
export type ContactInput = z.infer<typeof contactInputSchema>;

// The type is fixed at creation. The service validates a new value against the stored type.
export const contactUpdateSchema = z
  .strictObject({
    value: z.string().trim().min(1, "Contact value is required.").max(100).optional(),
    contactName: z.string().trim().max(100).nullable().optional(),
    isPrimary: z.literal(true).optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

/* ----------------------------- Subscribers ----------------------------- */

export const subscriberCreateSchema = z
  .object({
    fullName: z.string().trim().min(1, "Full name is required.").max(150),
    billingDay,
    collectionAreaId: z.uuid().nullish(),
    assignedCollectorId: z.uuid().nullish(),
    notes: z.string().trim().max(1000).nullish(),
    address: addressInputSchema,
    contacts: z.array(contactInputSchema).max(SUBSCRIBER_CONTACTS_MAX).default([]),
  })
  .superRefine((subscriber, ctx) => {
    const primaries = subscriber.contacts.filter((c) => c.isPrimary === true).length;
    if (primaries > 1) {
      ctx.addIssue({
        code: "custom",
        message: "Only one contact can be the primary contact.",
        path: ["contacts"],
      });
    }
  });
export type SubscriberCreateInput = z.infer<typeof subscriberCreateSchema>;

// Status and assignment have their own schemas, so they are rejected here.
export const subscriberUpdateSchema = z
  .strictObject({
    fullName: z.string().trim().min(1, "Full name is required.").max(150).optional(),
    billingDay: billingDay.optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type SubscriberUpdateInput = z.infer<typeof subscriberUpdateSchema>;

export const subscriberStatusChangeSchema = z.strictObject({
  status: z.enum(SUBSCRIBER_STATUSES),
  reason: z.string().trim().min(3, "A reason is required.").max(200),
});
export type SubscriberStatusChangeInput = z.infer<typeof subscriberStatusChangeSchema>;

// Both fields are required so the intent is explicit. null clears that part of the assignment.
export const subscriberAssignmentSchema = z.strictObject({
  collectionAreaId: z.uuid().nullable(),
  assignedCollectorId: z.uuid().nullable(),
  reason,
});
export type SubscriberAssignmentInput = z.infer<typeof subscriberAssignmentSchema>;

/* ----------------------------- List query ----------------------------- */

export const SUBSCRIBER_PAGE_SIZE_DEFAULT = 25;
export const SUBSCRIBER_PAGE_SIZE_MAX = 100;

// Query-string values arrive as text, so numbers are coerced.
// A blank search box is treated the same as no search.
export const subscriberListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(SUBSCRIBER_PAGE_SIZE_MAX)
    .default(SUBSCRIBER_PAGE_SIZE_DEFAULT),
  status: z.enum(SUBSCRIBER_STATUSES).optional(),
  collectionAreaId: z.uuid().optional(),
  assignedCollectorId: z.uuid().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
});
export type SubscriberListQuery = z.infer<typeof subscriberListQuerySchema>;
/* ---------------------------- Global search ---------------------------- */

export const GLOBAL_SEARCH_MIN_LENGTH = 2;
export const GLOBAL_SEARCH_LIMIT = 20;
/** Fewer digits than this would match far too many phone numbers. */
export const GLOBAL_SEARCH_MIN_PHONE_DIGITS = 4;

export const GLOBAL_SEARCH_FIELDS = [
  "accountNumber",
  "serviceNumber",
  "name",
  "contact",
  "address",
  "receiptNumber",
  "invoiceNumber",
  "gcashReference",
] as const;
export type GlobalSearchField = (typeof GLOBAL_SEARCH_FIELDS)[number];

export const globalSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(GLOBAL_SEARCH_MIN_LENGTH, `Type at least ${GLOBAL_SEARCH_MIN_LENGTH} characters to search.`)
    .max(100),
});
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

/**
 * The digits to look for in phone numbers, or null when the query is not phone-like.
 * A leading "0" or "63" is dropped so local and international forms find each other:
 * "0917 123 4567" and "+63 917 123 4567" both become "9171234567".
 */
export function phoneSearchDigits(query: string): string | null {
  if (!/^[0-9+()\-\s]+$/.test(query.trim())) return null;
  const digits = query.replace(/\D/g, "").replace(/^(63|0)/, "");
  return digits.length >= GLOBAL_SEARCH_MIN_PHONE_DIGITS ? digits : null;
}
