import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

export const GenerateResumeSchema = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
});
export type GenerateResumeDto = z.infer<typeof GenerateResumeSchema>;

/**
 * Share a resume. `channel` is a closed enum — no free text, so no link or PII
 * can leak into the emitted `resume.shared` event payload.
 */
export const ShareResumeSchema = z.object({
  channel: z.enum(["whatsapp", "link", "download", "other"]).default("link"),
});
export type ShareResumeDto = z.infer<typeof ShareResumeSchema>;
