import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Generate a resume (worker-authed, TD70 item 5). The ACTING worker id is
 * derived from the SESSION in the controller (XB-A: ids from the session,
 * never the body). `worker_id` stays accepted in the body ONLY for back-compat
 * with shipped worker-app clients that still send it — when present it must
 * equal the session worker or the request 404s (no existence oracle).
 */
export const GenerateResumeSchema = z.object({
  worker_id: uuidSchema.optional(),
  profile_id: uuidSchema,
});
export type GenerateResumeDto = z.infer<typeof GenerateResumeSchema>;

/**
 * Service-side generate input: `worker_id` is ALWAYS resolved by the caller —
 * the controller passes the session worker id; the auto-generate queue
 * processor passes the job's own workerId. Never a client-supplied value.
 */
export interface GenerateResumeInput {
  worker_id: string;
  profile_id: string;
}

/**
 * Share a resume. `channel` is a closed enum — no free text, so no link or PII
 * can leak into the emitted `resume.shared` event payload.
 */
export const ShareResumeSchema = z.object({
  channel: z.enum(["whatsapp", "link", "download", "other"]).default("link"),
});
export type ShareResumeDto = z.infer<typeof ShareResumeSchema>;
