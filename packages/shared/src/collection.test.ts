import { describe, expect, it } from "vitest";
import {
  areaCreateSchema,
  areaUpdateSchema,
  collectorCreateSchema,
  collectorUpdateSchema,
} from "./collection";

describe("collection areas", () => {
  it("trims and uppercases the code", () => {
    const r = areaCreateSchema.parse({ code: " lumbo-1 ", name: "Lumbo" });
    expect(r.code).toBe("LUMBO-1");
  });

  it("rejects a code with spaces", () => {
    expect(areaCreateSchema.safeParse({ code: "a b", name: "X" }).success).toBe(false);
  });

  it("requires a change besides the reason on update", () => {
    expect(areaUpdateSchema.safeParse({ reason: "typo" }).success).toBe(false);
  });

  it("rejects changing the code on update", () => {
    expect(areaUpdateSchema.safeParse({ code: "NEW" }).success).toBe(false);
  });
});

describe("collectors", () => {
  it("allows creating a collector without a linked user", () => {
    const r = collectorCreateSchema.parse({ code: "col-1", fullName: "Juan Dela Cruz" });
    expect(r.code).toBe("COL-1");
    expect(r.userId).toBeUndefined();
  });

  it("rejects a userId that is not a uuid", () => {
    const r = collectorCreateSchema.safeParse({ code: "COL-2", fullName: "X", userId: "abc" });
    expect(r.success).toBe(false);
  });

  it("allows unlinking the user with null on update", () => {
    expect(collectorUpdateSchema.safeParse({ userId: null }).success).toBe(true);
  });
});