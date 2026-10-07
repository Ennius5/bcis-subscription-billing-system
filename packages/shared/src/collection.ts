import { z } from "zod";

const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{2,20}$/, "Code must be 2-20 letters, digits or hyphens.")
  .toUpperCase();

const reason = z.string().trim().max(200).optional();

const hasChange = (v: Record<string, unknown>) =>
  Object.keys(v).some((k) => k !== "reason");
const noChangeMessage = { message: "Provide at least one field to change." };

export const areaCreateSchema = z.object({
  code,
  name: z.string().trim().min(1, "Name is required.").max(100),
  description: z.string().trim().max(500).nullish(),
});
export type AreaCreateInput = z.infer<typeof areaCreateSchema>;

export const areaUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1, "Name is required.").max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type AreaUpdateInput = z.infer<typeof areaUpdateSchema>;

export const collectorCreateSchema = z.object({
  code,
  fullName: z.string().trim().min(1, "Full name is required.").max(100),
  contactNumber: z.string().trim().max(30).nullish(),
  userId: z.uuid().nullish(),
});
export type CollectorCreateInput = z.infer<typeof collectorCreateSchema>;

export const collectorUpdateSchema = z
  .strictObject({
    fullName: z.string().trim().min(1, "Full name is required.").max(100).optional(),
    contactNumber: z.string().trim().max(30).nullable().optional(),
    userId: z.uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    reason,
  })
  .refine(hasChange, noChangeMessage);
export type CollectorUpdateInput = z.infer<typeof collectorUpdateSchema>;