import { z } from "zod";
import { uuidSchema, consentPurposesSchema } from "@badabhai/validators";

export const AcceptConsentSchema = z.object({
  worker_id: uuidSchema,
  consent_version: z.string().min(1).max(32),
  purposes: consentPurposesSchema,
});
export type AcceptConsentDto = z.infer<typeof AcceptConsentSchema>;
