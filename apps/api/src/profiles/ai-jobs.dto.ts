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
