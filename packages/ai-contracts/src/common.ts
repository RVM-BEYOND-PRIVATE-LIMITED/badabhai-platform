// Cross-cutting contract pieces: the conversation message envelope, the AI call
// metadata every LLM-backed response carries, and the pseudonymization gateway
// contracts (plus the label-only meta the other modules embed).
import { z } from "zod";

export const ConversationMessageSchema = z.object({
  role: z.enum(["worker", "assistant", "system"]),
  text: z.string(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

// ---------------------------------------------------------------------------
// AI call metadata (cost / observability). Carries NO PII.
// ---------------------------------------------------------------------------
export const AICallMetadataSchema = z.object({
  ai_call_id: z.string(),
  task_type: z.string(),
  model_name: z.string(),
  provider: z.string(),
  real_call: z.boolean(),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  estimated_cost_inr: z.number().nonnegative().default(0),
  latency_ms: z.number().int().nonnegative().default(0),
  success: z.boolean().default(true),
  error_code: z.string().nullable().default(null),
  cost_alert: z.boolean().default(false),
  above_target: z.boolean().default(false),
  // Diagnostics (additive, defaulted → back-compat): reconcile per-attempt log
  // volume vs per-call metadata and surface the specific transport failure.
  // PII-free: an int count, model ids, and a closed-set reason code. Mirrors the
  // Pydantic AICallMetadata in apps/ai-service/app/contracts.py.
  attempt_count: z.number().int().nonnegative().default(0),
  candidates_tried: z.array(z.string()).default([]),
  failure_reason: z.string().nullable().default(null),
  created_at: z.string(),
});
export type AICallMetadata = z.infer<typeof AICallMetadataSchema>;

// Pseudonymization summary (label-only; safe to return/trace).
export const PseudonymizationMetaSchema = z.object({
  blocked: z.boolean(),
  blocked_reason: z.string().nullable().default(null),
  replaced_entities: z.number().int().nonnegative().default(0),
  placeholder_tokens: z.array(z.string()).default([]),
});
export type PseudonymizationMeta = z.infer<typeof PseudonymizationMetaSchema>;

// ---------------------------------------------------------------------------
// Pseudonymization
// ---------------------------------------------------------------------------
export const PseudonymizationInputSchema = z.object({
  text: z.string(),
  request_id: z.string().min(1).optional(),
});
export type PseudonymizationInput = z.infer<typeof PseudonymizationInputSchema>;

export const PseudonymizationOutputSchema = z.object({
  pseudonymized_text: z.string(),
  /** True when the text could not be safely pseudonymized (fail closed). */
  blocked: z.boolean(),
  blocked_reason: z.string().nullable().default(null),
  replaced_entities: z.number().int().nonnegative(),
  /** Placeholder token labels only (e.g. "[PERSON_1]"). NEVER raw values. */
  placeholder_tokens: z.array(z.string()).default([]),
});
export type PseudonymizationOutput = z.infer<typeof PseudonymizationOutputSchema>;
