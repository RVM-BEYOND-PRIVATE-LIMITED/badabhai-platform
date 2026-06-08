import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

export const ExtractProfileSchema = z.object({
  worker_id: uuidSchema,
  session_id: uuidSchema.optional(),
});
export type ExtractProfileDto = z.infer<typeof ExtractProfileSchema>;

export const ConfirmProfileSchema = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
});
export type ConfirmProfileDto = z.infer<typeof ConfirmProfileSchema>;
