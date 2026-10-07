import { describe, expect, it } from "vitest";
import {
  addressUpdateSchema,
  allowedStatusTransitions,
  contactUpdateSchema,
  contactValueProblem,
  statusChangeProblem,
  SUBSCRIBER_STATUSES,
  subscriberAssignmentSchema,
  subscriberCreateSchema,
  subscriberStatusChangeSchema,
  subscriberUpdateSchema,
} from "./subscribers";

const UUID = "00000000-0000-4000-8000-000000000001";

const validSubscriber = {
  fullName: "Juan Dela Cruz",
  billingDay: 5,
  address: { line1: "Purok 3", barangay: "Lumbo", city: "Valencia City" },
};

describe("subscriber status rules", () => {
  it("allows the documented transitions", () => {
    expect(statusChangeProblem("active", "inactive")).toBeNull();
    expect(statusChangeProblem("active", "terminated")).toBeNull();
    expect(statusChangeProblem("inactive", "active")).toBeNull();
    expect(statusChangeProblem("inactive", "terminated")).toBeNull();
    expect(statusChangeProblem("terminated", "archived")).toBeNull();
  });

  it("does not allow archiving without terminating first", () => {
    expect(statusChangeProblem("active", "archived")).not.toBeNull();
    expect(statusChangeProblem("inactive", "archived")).not.toBeNull();
  });

  it("does not allow a terminated subscriber to be reactivated", () => {
    expect(statusChangeProblem("terminated", "active")).not.toBeNull();
    expect(statusChangeProblem("terminated", "inactive")).not.toBeNull();
  });

  it("treats archived as final", () => {
    expect(allowedStatusTransitions("archived")).toHaveLength(0);
    for (const to of SUBSCRIBER_STATUSES) {
      expect(statusChangeProblem("archived", to)).not.toBeNull();
    }
  });

  it("rejects a change to the same status", () => {
    expect(statusChangeProblem("active", "active")).toBe("The subscriber is already active.");
  });
});

describe("status change schema", () => {
  it("requires a reason", () => {
    expect(subscriberStatusChangeSchema.safeParse({ status: "inactive" }).success).toBe(false);
  });

  it("rejects a blank or too-short reason", () => {
    expect(subscriberStatusChangeSchema.safeParse({ status: "inactive", reason: "   " }).success).toBe(false);
    expect(subscriberStatusChangeSchema.safeParse({ status: "inactive", reason: "ab" }).success).toBe(false);
  });

  it("accepts and trims a valid reason", () => {
    const r = subscriberStatusChangeSchema.parse({ status: "terminated", reason: "  moved away  " });
    expect(r.reason).toBe("moved away");
  });
});

describe("contact value rules", () => {
  it("accepts a valid email and rejects a malformed one", () => {
    expect(contactValueProblem("email", "juan@example.com")).toBeNull();
    expect(contactValueProblem("email", "juan@")).not.toBeNull();
    expect(contactValueProblem("email", "no spaces@example.com")).not.toBeNull();
  });

  it("accepts common phone formats", () => {
    expect(contactValueProblem("mobile", "0917 123 4567")).toBeNull();
    expect(contactValueProblem("mobile", "+63 917-123-4567")).toBeNull();
    expect(contactValueProblem("landline", "(088) 828-1234")).toBeNull();
  });

  it("rejects letters and too few digits in phone numbers", () => {
    expect(contactValueProblem("mobile", "0917-abc-4567")).not.toBeNull();
    expect(contactValueProblem("landline", "123")).not.toBeNull();
    expect(contactValueProblem("mobile", "1".repeat(16))).not.toBeNull();
  });

  it("accepts any non-empty text for the other type", () => {
    expect(contactValueProblem("other", "Facebook: Juan DC")).toBeNull();
    expect(contactValueProblem("other", "   ")).not.toBeNull();
  });
});

describe("subscriber create schema", () => {
  it("accepts a minimal subscriber and defaults contacts to empty", () => {
    const r = subscriberCreateSchema.parse(validSubscriber);
    expect(r.contacts).toEqual([]);
    expect(r.collectionAreaId).toBeUndefined();
    expect(r.address.barangay).toBe("Lumbo");
  });

  it("rejects a billing day outside 1-28 or not a whole number", () => {
    for (const billingDay of [0, 29, 15.5]) {
      expect(subscriberCreateSchema.safeParse({ ...validSubscriber, billingDay }).success).toBe(false);
    }
  });

  it("requires street, barangay and city on the address", () => {
    const r = subscriberCreateSchema.safeParse({
      ...validSubscriber,
      address: { line1: "Purok 3", barangay: "", city: "" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("address.barangay");
      expect(paths).toContain("address.city");
    }
  });

  it("rejects more than one primary contact", () => {
    const r = subscriberCreateSchema.safeParse({
      ...validSubscriber,
      contacts: [
        { type: "mobile", value: "0917 123 4567", isPrimary: true },
        { type: "email", value: "juan@example.com", isPrimary: true },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("reports an invalid contact value at that contact's own path", () => {
    const r = subscriberCreateSchema.safeParse({
      ...validSubscriber,
      contacts: [{ type: "mobile", value: "abc" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["contacts", 0, "value"]);
    }
  });
});

describe("update schemas", () => {
  it("subscriber update cannot change status or account number", () => {
    expect(subscriberUpdateSchema.safeParse({ status: "inactive" }).success).toBe(false);
    expect(subscriberUpdateSchema.safeParse({ accountNumber: "BCIS-000999" }).success).toBe(false);
  });

  it("subscriber update requires a change besides the reason", () => {
    expect(subscriberUpdateSchema.safeParse({ reason: "typo" }).success).toBe(false);
    expect(subscriberUpdateSchema.safeParse({ notes: null }).success).toBe(true);
  });

  it("address update can only promote an address to primary", () => {
    expect(addressUpdateSchema.safeParse({ isPrimary: false }).success).toBe(false);
    expect(addressUpdateSchema.safeParse({ isPrimary: true }).success).toBe(true);
  });

  it("contact update cannot change the type", () => {
    expect(contactUpdateSchema.safeParse({ type: "email" }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ value: "0917 123 4567" }).success).toBe(true);
  });

  it("assignment change requires both fields and accepts null to clear", () => {
    expect(subscriberAssignmentSchema.safeParse({ collectionAreaId: UUID }).success).toBe(false);
    expect(
      subscriberAssignmentSchema.safeParse({ collectionAreaId: null, assignedCollectorId: null }).success,
    ).toBe(true);
    expect(
      subscriberAssignmentSchema.safeParse({ collectionAreaId: UUID, assignedCollectorId: null }).success,
    ).toBe(true);
  });

  it("assignment change rejects ids that are not uuids", () => {
    const r = subscriberAssignmentSchema.safeParse({
      collectionAreaId: "zone-1",
      assignedCollectorId: null,
    });
    expect(r.success).toBe(false);
  });
});