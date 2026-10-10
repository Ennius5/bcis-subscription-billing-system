import { z } from "zod";
import { ROLE_DEFINITIONS, type RoleCode } from "./permissions";

/** Shortest password the system accepts (Phase 9 decision 2). */
export const PASSWORD_MIN_LENGTH = 10;
/** argon2 can hash longer input, but nobody types more than this. */
export const PASSWORD_MAX_LENGTH = 256;

export const ROLE_CODES = ROLE_DEFINITIONS.map((r) => r.code) as [RoleCode, ...RoleCode[]];

export const ROLE_LABELS = Object.fromEntries(
  ROLE_DEFINITIONS.map((r) => [r.code, r.name]),
) as Record<RoleCode, string>;

const reason = z.string().trim().max(200).optional();

const hasChange = (v: Record<string, unknown>) => Object.keys(v).some((k) => k !== "reason");
const noChangeMessage = { message: "Provide at least one field to change." };

// Passwords are never trimmed: a leading or trailing space is part of the password.
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "Username must be 3-32 letters, digits, dots, hyphens or underscores.");

const fullName = z.string().trim().min(1, "Full name is required.").max(150);

const roleList = z
  .array(z.enum(ROLE_CODES))
  .min(1, "Pick at least one role.")
  .refine((roles) => new Set(roles).size === roles.length, "A role is listed twice.");

export const userCreateSchema = z.strictObject({
  username: usernameSchema,
  fullName,
  // The first password is temporary: the user must replace it at first sign-in.
  temporaryPassword: passwordSchema,
  roles: roleList,
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

// Usernames are codes and cannot be edited.
export const userUpdateSchema = z
  .strictObject({
    fullName: fullName.optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

export const userRolesChangeSchema = z.strictObject({
  roles: roleList,
  reason,
});
export type UserRolesChangeInput = z.infer<typeof userRolesChangeSchema>;

export const userStatusChangeSchema = z.strictObject({
  isActive: z.boolean(),
  reason: z.string().trim().min(3, "A reason is required.").max(200),
});
export type UserStatusChangeInput = z.infer<typeof userStatusChangeSchema>;

export const userUnlockSchema = z.strictObject({ reason });
export type UserUnlockInput = z.infer<typeof userUnlockSchema>;

export const passwordResetSchema = z.strictObject({
  temporaryPassword: passwordSchema,
  reason,
});
export type PasswordResetInput = z.infer<typeof passwordResetSchema>;

export const passwordChangeSchema = z
  .strictObject({
    currentPassword: z.string().min(1, "Enter your current password.").max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: "The new password must be different from the current one.",
    path: ["newPassword"],
  });
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;
