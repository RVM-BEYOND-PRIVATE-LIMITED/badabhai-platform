import { z } from "zod";

export const AiJobOutputRefSchema = z.union([
  z.object({ profile_id: z.string() }),
  z.object({ voice_note_id: z.string() }),
  z.object({ resume_id: z.string() }),
  z.object({}).strict(),
]);
export type AiJobOutputRef = z.infer<typeof AiJobOutputRefSchema>;

export const AiJobUsageSchema = z.object({
  model_name: z.string().nullable(),
  real_call: z.boolean().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  cost_inr: z.number().nullable(),
});
export type AiJobUsage = z.infer<typeof AiJobUsageSchema>;

/**
 * The WORKER-facing projection (`GET /workers/me/ai-jobs/:id`) — deliberately three
 * keys, and deliberately NOT a subset-by-omission of {@link AiJobResponseSchema}.
 *
 * `output_ref` is flattened into two explicitly-named opaque ids rather than passed
 * through as a jsonb blob, so a future key added to that column cannot reach a worker
 * by accident. Everything the ops route returns beyond this — `ai_usage` (cost, model,
 * `real_call`, token counts), `error_message`, `id`, `job_type`, timestamps — is
 * withheld; see the rationale on {@link import("./worker-ai-jobs.controller")}.
 *
 * NOT a Zod schema: an output projection, not boundary input — the same rule
 * `workers.dto.ts` states for `WorkerResumeFields`. Nothing in this repo `.parse()`s a
 * response, so declaring one here would look like an enforced contract while enforcing
 * nothing. What actually pins the projection is `worker-ai-jobs.controller.test.ts`,
 * which asserts the exact key set and that each withheld field is absent.
 *
 * `status` is the same closed union as the ops route, because the client's whole poll
 * loop is a fold over it.
 */
export interface WorkerAiJobResponse {
  status: "queued" | "running" | "completed" | "failed";
  profile_id: string | null;
  voice_note_id: string | null;
}

export const AiJobResponseSchema = z.object({
  id: z.string().uuid(),
  job_type: z.enum(["pseudonymization", "transcription", "profile_extraction", "resume_generation"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  output_ref: AiJobOutputRefSchema.nullable(),
  error_message: z.string().nullable(),
  ai_usage: AiJobUsageSchema,
  created_at: z.date(),
  updated_at: z.date(),
});
export type AiJobResponse = z.infer<typeof AiJobResponseSchema>;
