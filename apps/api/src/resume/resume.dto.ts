import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

export const GenerateResumeSchema = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
});
export type GenerateResumeDto = z.infer<typeof GenerateResumeSchema>;
