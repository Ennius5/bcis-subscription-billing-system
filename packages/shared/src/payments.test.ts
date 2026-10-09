import { describe, expect, it } from "vitest";
import {
  detectProofType,
  gcashRejectSchema,
  gcashSubmissionCreateSchema,
  normalizeGcashReference,
  paymentCreateSchema,
  paymentReverseSchema,
} from "./payments";

const UUID = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";

describe("GCash reference normalization (AT-05)", () => {
  it("treats spacing and letter case as the same reference", () => {
    expect(normalizeGcashReference(" 1012 345 678901 ")).toBe("1012345678901");
    expect(normalizeGcashReference("ab12\tcd34")).toBe("AB12CD34");
  });
});

describe("proof file type detection", () => {
  const withTail = (head: number[]) => new Uint8Array([...head, 0, 0, 0, 0]);

  it("recognizes PNG, JPEG and WebP by their first bytes", () => {
    expect(detectProofType(withTail([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectProofType(withTail([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      detectProofType(withTail([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
  });

  it("rejects anything else, whatever the file is called", () => {
    expect(detectProofType(new TextEncoder().encode("%PDF-1.7 fake"))).toBeNull();
    expect(detectProofType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    // A RIFF file that is not WebP (e.g. a WAV).
    expect(detectProofType(withTail([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(detectProofType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectProofType(new Uint8Array())).toBeNull();
  });
});

describe("paymentCreateSchema", () => {
  const base = { subscriberId: UUID, method: "cash", amountCentavos: 99_900 };

  it("accepts a plain cash payment", () => {
    expect(paymentCreateSchema.parse(base)).toEqual(base);
  });

  it("rejects zero, negative and fractional amounts", () => {
    for (const amountCentavos of [0, -100, 99.5]) {
      expect(paymentCreateSchema.safeParse({ ...base, amountCentavos }).success).toBe(false);
    }
  });

  it("does not post GCash at the counter; GCash goes through verification", () => {
    expect(paymentCreateSchema.safeParse({ ...base, method: "gcash", referenceNumber: "1012345678901" }).success).toBe(
      false,
    );
  });

  it("requires the cheque number or bank reference", () => {
    const cheque = paymentCreateSchema.safeParse({ ...base, method: "cheque" });
    expect(cheque.success).toBe(false);
    expect(cheque.error?.issues[0]?.path).toEqual(["referenceNumber"]);
    expect(paymentCreateSchema.safeParse({ ...base, method: "bank_transfer", referenceNumber: " " }).success).toBe(false);
    expect(paymentCreateSchema.safeParse({ ...base, method: "cheque", referenceNumber: "CHK 004512" }).success).toBe(true);
  });

  it("accepts manual allocations that leave some credit", () => {
    const parsed = paymentCreateSchema.parse({
      ...base,
      amountCentavos: 150_000,
      allocations: [{ invoiceId: UUID2, amountCentavos: 99_900 }],
    });
    expect(parsed.allocations).toHaveLength(1);
  });

  it("rejects manual allocations larger than the payment, or listing an invoice twice", () => {
    expect(
      paymentCreateSchema.safeParse({ ...base, allocations: [{ invoiceId: UUID2, amountCentavos: 100_000 }] }).success,
    ).toBe(false);
    expect(
      paymentCreateSchema.safeParse({
        ...base,
        allocations: [
          { invoiceId: UUID2, amountCentavos: 100 },
          { invoiceId: UUID2, amountCentavos: 100 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields such as a receipt number", () => {
    expect(paymentCreateSchema.safeParse({ ...base, receiptNumber: "RCPT-000001" }).success).toBe(false);
  });
});

describe("gcashSubmissionCreateSchema", () => {
  const base = {
    subscriberId: UUID,
    referenceNumber: "1012 345 678901",
    senderName: "Demo Sender",
    senderNumber: "0917 000 0001",
    amountCentavos: 99_900,
    transactionDate: "2026-09-20",
  };

  it("stores the reference normalized", () => {
    expect(gcashSubmissionCreateSchema.parse(base).referenceNumber).toBe("1012345678901");
  });

  it("rejects references with symbols or that are too short", () => {
    expect(gcashSubmissionCreateSchema.safeParse({ ...base, referenceNumber: "12-34" }).success).toBe(false);
    expect(gcashSubmissionCreateSchema.safeParse({ ...base, referenceNumber: "12345" }).success).toBe(false);
  });

  it("requires a sender number that looks like a phone number", () => {
    expect(gcashSubmissionCreateSchema.safeParse({ ...base, senderNumber: "call me" }).success).toBe(false);
  });

  it("requires the transaction date", () => {
    const { transactionDate: _omit, ...rest } = base;
    expect(gcashSubmissionCreateSchema.safeParse(rest).success).toBe(false);
  });
});

describe("reasons", () => {
  it("are required for reversals and rejections", () => {
    expect(paymentReverseSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(gcashRejectSchema.safeParse({}).success).toBe(false);
    expect(paymentReverseSchema.parse({ reason: "Posted to the wrong subscriber" }).reason).toBe(
      "Posted to the wrong subscriber",
    );
  });
});
