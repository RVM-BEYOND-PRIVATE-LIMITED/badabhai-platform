import { z } from "zod";

// Shared primitives for every ai-contract module: the language-code helper, the
// conversation message envelope, AI call metadata (cost/observability) and the
// pseudonymization gateway contracts.

const languageCode = z.string().min(2).max(8);
// Internal shared primitive. Exported for sibling modules only — deliberately NOT
// re-exported from the barrel, so the package's public surface is unchanged.
export { languageCode };

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
  /**
   * THE FINAL PROMPT AND COMPLETION, ALREADY THROUGH THE PSEUDONYMIZATION GATE — the only
   * text on this contract, and the only text `ai_call_traces` (migration 0083) may store.
   *
   * ── WHY THESE HAD TO BE ADDED HERE, AND WHAT BREAKS WITHOUT THEM ────────────────────
   * `z.object` STRIPS unknown keys (zod 3), silently. The python side has populated
   * `AICallMetadata.prompt_text` / `response_text` since `AIRouter._record_trace_text`
   * landed, and every one of those values was being dropped on the floor at
   * `AiService`'s `schema.parse(await res.json())` — no error, no warning, no data. The
   * writer then fell back to the API-side REQUEST OBJECT, which on a worker surface is
   * the worker's own words with nothing taken out of them, because the pseudonymizer runs
   * on the FAR side of this hop. So the absence of these two fields was not a gap in a
   * diagnostic: it was the difference between storing masked text and storing raw text.
   *
   * ── WHAT THE VALUES ARE ─────────────────────────────────────────────────────────────
   * Both are produced by `apps/ai-service/app/ai/router.py::_record_trace_text`, which is
   * their only writer. It runs each through the SAME mask object the Langfuse SDK is
   * handed (`masked_trace_text` → `app/pseudonymize.py`), so the store and the tracer
   * share one rendering and one privacy gate. `prompt_text` is the flattened message list
   * the router dispatched; `response_text` is the string the caller got back.
   *
   * ── AND WHAT THEY ARE NOT ───────────────────────────────────────────────────────────
   * NOT a guarantee the text is clean. A pseudonymizer is a best-effort transform over
   * free text and R32 measured the name gazetteer's recall as poor. Post-boundary means
   * the gate RAN, not that it caught everything — which is why the store encrypts at rest
   * and gates the read on a super-admin capability rather than treating this as safe.
   *
   * NULL IS THE NORMAL CASE, on three counts, and every consumer must handle it: the
   * ai-service flag `AI_CALL_TRACE_TEXT_ENABLED` is default OFF; the surfaces that do not
   * go through `AIRouter` (embeddings, STT, translate) never populate them; and an older
   * ai-service that predates the field sends nothing at all. `.default(null)` keeps that
   * last case a successful parse rather than a 500 on every AI call — the same
   * additive-and-defaulted rule the diagnostics block above follows.
   */
  prompt_text: z.string().nullable().default(null),
  response_text: z.string().nullable().default(null),
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
