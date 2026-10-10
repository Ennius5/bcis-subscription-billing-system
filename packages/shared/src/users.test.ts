import { describe, expect, it } from "vitest";
import {
  passwordChangeSchema,
  passwordResetSchema,
  ROLE_LABELS,
  userCreateSchema,
  userRolesChangeSchema,
  userStatusChangeSchema,
  userUpdateSchema,
} from "./users";

const validUser = {
  username: "  Maria.Santos ",
  fullName: "Maria Santos",
  temporaryPassword: "temp-pass-123",
  roles: ["cashier"],
};

describe("userCreateSchema", () => {
  it("trims and lowercases the username", () => {
    const parsed = userCreateSchema.parse(validUser);
    expect(parsed.username).toBe("maria.santos");
  });

  it("rejects usernames with spaces or symbols", () => {
    expect(userCreateSchema.safeParse({ ...validUser, username: "maria santos" }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...validUser, username: "ab" }).success).toBe(false);
  });

  it("needs a password of at least 10 characters and keeps spaces", () => {
    expect(userCreateSchema.safeParse({ ...validUser, temporaryPassword: "short-123" }).success).toBe(false);
    const parsed = userCreateSchema.parse({ ...validUser, temporaryPassword: " spaced pass " });
    expect(parsed.temporaryPassword).toBe(" spaced pass ");
  });

  it("needs at least one known role and no repeats", () => {
    expect(userCreateSchema.safeParse({ ...validUser, roles: [] }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...validUser, roles: ["janitor"] }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...validUser, roles: ["cashier", "cashier"] }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(userCreateSchema.safeParse({ ...validUser, isActive: false }).success).toBe(false);
  });
});

describe("user change schemas", () => {
  it("update needs a change besides the reason and cannot touch the username", () => {
    expect(userUpdateSchema.safeParse({ reason: "typo" }).success).toBe(false);
    expect(userUpdateSchema.safeParse({ fullName: "Maria S. Santos" }).success).toBe(true);
    expect(userUpdateSchema.safeParse({ username: "other" }).success).toBe(false);
  });

  it("status change requires a reason", () => {
    expect(userStatusChangeSchema.safeParse({ isActive: false }).success).toBe(false);
    expect(userStatusChangeSchema.safeParse({ isActive: false, reason: "Resigned" }).success).toBe(true);
  });

  it("role change needs at least one role", () => {
    expect(userRolesChangeSchema.safeParse({ roles: [] }).success).toBe(false);
    expect(userRolesChangeSchema.safeParse({ roles: ["auditor", "viewer"] }).success).toBe(true);
  });

  it("reset applies the password rules", () => {
    expect(passwordResetSchema.safeParse({ temporaryPassword: "123" }).success).toBe(false);
  });

  it("a new password must differ from the current one", () => {
    const same = passwordChangeSchema.safeParse({ currentPassword: "same-pass-123", newPassword: "same-pass-123" });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.path).toEqual(["newPassword"]);
  });

  it("has a label for every role", () => {
    expect(ROLE_LABELS.collection_supervisor).toBe("Collection Supervisor");
  });
});
