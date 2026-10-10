import { describe, expect, it } from "vitest";
import { auditCategory, auditLogQuerySchema, userActivityQuerySchema } from "./audit";

describe("auditCategory", () => {
  it("groups actions by prefix or exact match", () => {
    expect(auditCategory("payment.reverse")).toBe("payments");
    expect(auditCategory("gcash.verify")).toBe("payments");
    expect(auditCategory("invoice.void")).toBe("billing");
    expect(auditCategory("service_account.suspend")).toBe("services");
    expect(auditCategory("collection_batch.reconcile")).toBe("collections");
    expect(auditCategory("report.export")).toBe("exports");
    expect(auditCategory("soa.export")).toBe("exports");
    expect(auditCategory("settings.update")).toBe("administration");
    expect(auditCategory("report.view")).toBe("other");
    expect(auditCategory("something.new")).toBe("other");
  });
});

describe("audit query schemas", () => {
  it("accepts open-ended filters and pages, refuses reversed ranges", () => {
    expect(auditLogQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(auditLogQuerySchema.safeParse({ from: "2026-10-10", to: "2026-10-01" }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ category: "secrets" }).success).toBe(false);
    expect(userActivityQuerySchema.safeParse({ from: "2026-10-01" }).success).toBe(false);
  });
});
