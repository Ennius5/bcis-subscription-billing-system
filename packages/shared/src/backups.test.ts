import { describe, expect, it } from "vitest";
import { backupIsStale, backupRestoreSchema } from "./backups";

describe("backupIsStale", () => {
  const now = new Date("2026-10-11T08:00:00Z");
  it("is stale with no good backup at all", () => {
    expect(backupIsStale(null, now)).toBe(true);
  });
  it("is fresh within 24 hours and stale after", () => {
    expect(backupIsStale(new Date("2026-10-10T09:00:00Z"), now)).toBe(false);
    expect(backupIsStale(new Date("2026-10-10T07:59:00Z"), now)).toBe(true);
  });
});

describe("backupRestoreSchema", () => {
  it("needs the typed number and a reason", () => {
    expect(backupRestoreSchema.safeParse({ confirmBackupNumber: "", reason: "Bad import" }).success).toBe(false);
    expect(backupRestoreSchema.safeParse({ confirmBackupNumber: "BK-000001", reason: "" }).success).toBe(false);
    expect(backupRestoreSchema.safeParse({ confirmBackupNumber: "BK-000001", reason: "Bad import" }).success).toBe(true);
  });
});
