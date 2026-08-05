import { z } from "zod";

import {
  AICallMetadataSchema,
  ConversationMessageSchema,
  PseudonymizationMetaSchema,
  languageCode,
} from "./common";

// Worker-side chat profiling: the conversation state carried between turns, the
// one-shot opener, and the profiling turn request/response.

// Interview conversation state (profile signals only — never identity PII).
export const ConversationStateSchema = z.object({
  role_family: z.string().default("cnc_vmc"),
  turn_count: z.number().int().nonnegative().default(0),
  answered_topics: z.array(z.string().min(1).max(40).regex(/^[a-z_]+$/, "topic_id must be lowercase slug ([a-z_]+)")).default([]),
  asked_question_ids: z.array(z.string()).default([]),
  collected: z.record(z.string(), z.unknown()).default({}),
  /**
   * COST-4 clarify bound (additive, defaulted => backward compatible; mirrors
   * contracts.py ConversationState): CONSECUTIVE clarify re-serves of the same
   * question. The engine's clarify_turn increments it and refuses past 2 (falls
   * through to next_turn); every next_turn resets it to 0.
   */
  clarify_count: z.number().int().nonnegative().default(0),
  /**
   * INTERVIEW-1 re-ask bound (additive, defaulted => backward compatible; mirrors
   * contracts.py ConversationState): per-topic ASK count. `asked_question_ids` is a
   * dedup set and cannot count, so the bounded re-ask needs its own counter. The
   * engine's `_next_topic` refuses past MAX_ASKS_PER_TOPIC (2), so a topic the
   * CNC/VMC-only detector can never parse is asked twice, never forever.
   * Topic ids only — no PII.
   *
   * NOT a total: the COST-4 clarify path re-serves the last question WITHOUT
   * incrementing this (those re-serves are bounded separately by `clarify_count`).
   * `ask_counts` counts engine-driven asks only.
   */
  ask_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * INTERVIEW-1 completeness signal (additive, defaulted => backward compatible;
   * mirrors contracts.py ConversationState): the ESSENTIAL topics the worker never
   * actually answered. Empty array = complete.
   *
   * This — NOT `extraction_ready` — declares an incomplete profile.
   * `extraction_ready` keeps its frozen v1 meaning ("the interview is over, run
   * extraction") because it is the sole gate on extraction downstream, so making it
   * false on a gap would yield no profile and no resume at all. This list is read to
   * MARK the extracted profile incomplete, making a `role: null` resume a known
   * outcome. Topic ids only — no PII. The API-side consumer is a follow-up task.
   */
  unanswered_essentials: z.array(z.string()).default([]),

  // --- Generalized profiling (the LLM-driven interview) ---------------------
  // ADDITIVE + defaulted => backward compatible, and mirrored in
  // apps/ai-service/app/contracts.py ConversationState.
  /**
   * The Resume Field Set as filled so far: `{field_id: short value}`.
   *
   * It REPLACES `collected` as the thing that matters, and it is what makes "never ask
   * what has already been answered" work with no deterministic engine tracking it — the
   * ai-service feeds it back to the model every turn. Keys are the closed RFS
   * vocabulary (PROFILING_REQUIRED_FIELDS + PROFILING_OPTIONAL_FIELDS); an id the
   * model invents is dropped on the far side and never lands here.
   *
   * DEFINED HERE AND NOT ONLY IN PYDANTIC, and that is load-bearing rather than tidy:
   * `AiService.profilingRespond` runs the response through
   * `ProfilingTurnOutputSchema.parse`, and a Zod object STRIPS keys it does not
   * declare. Omitting this field would silently discard every captured answer on the
   * way back into the API — no error, no failing test on either side, and an interview
   * that re-asks the same seven questions until the turn cap fires.
   *
   * PRIVACY: profile signals only, exactly like `collected` beside it. There is no RFS
   * field for a name, phone, address, employer or ID; the persona forbids asking, and
   * pseudonymize blocks upstream.
   */
  captured: z.record(z.string(), z.string()).default({}),
  /**
   * WHY the interview ended (`fields_complete` | `turn_cap`), for observability.
   * Never model-supplied — the ai-service assigns it, because a model does not get to
   * decide that it is finished.
   */
  completion_reason: z.string().nullable().default(null),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

// ---------------------------------------------------------------------------
// Profiling turn (one back-and-forth in the chat profiling flow)
// ---------------------------------------------------------------------------
export const ProfilingTurnInputSchema = z.object({
  session_id: z.string().min(1),
  /** Pseudonymous worker reference (NOT a raw worker id is required). */
  worker_ref: z.string().min(1).optional(),
  language: languageCode.optional(),
  message_text: z.string().min(1),
  history: z.array(ConversationMessageSchema).default([]),
  // Phase-1 additions. OPTIONAL (not defaulted) so the inferred input type stays
  // backward compatible for existing callers; the AI service supplies defaults.
  role_family: z.string().optional(),
  conversation_state: ConversationStateSchema.nullable().optional(),
  real_call_allowed: z.boolean().optional(),
  /**
   * The API's turn cap fired. The model is still called (ONE code path), but it is told
   * to close warmly rather than ask, and completion is forced on the way out whatever
   * comes back.
   *
   * THE CAP IS API-AUTHORITATIVE, and that is the point of sending it rather than
   * letting the ai-service count. A model must never be able to extend its own
   * interview, and the ai-service holds no per-session state to count turns with — the
   * API owns the Redis buffer, so the API owns the budget. `PROFILING_MAX_TURNS` on
   * the far side is a second, independent clamp, not the primary one.
   */
  force_complete: z.boolean().optional(),
});
export type ProfilingTurnInput = z.infer<typeof ProfilingTurnInputSchema>;

/** One-shot opener (POST /profiling/opening). Mirrors app/contracts.py. */
export const ProfilingOpeningInputSchema = z.object({
  role_family: z.string().optional(),
});
export type ProfilingOpeningInput = z.infer<typeof ProfilingOpeningInputSchema>;

/**
 * Deliberately just the string: no `is_mock`, no `ai_metadata` (deterministic
 * template — no model call, nothing pseudonymized) and no `worker_name` (the
 * opener carries no vocative, which keeps the endpoint PII-free by construction).
 */
export const ProfilingOpeningOutputSchema = z.object({
  opening_text: z.string(),
});
export type ProfilingOpeningOutput = z.infer<typeof ProfilingOpeningOutputSchema>;

export const ProfilingTurnOutputSchema = z.object({
  reply_text: z.string(),
  blocked: z.boolean().default(false),
  blocked_reason: z.string().nullable().default(null),
  suggested_followups: z.array(z.string()).default([]),
  /** True when the response came from the mock path (AI_ENABLE_REAL_CALLS=false). */
  is_mock: z.boolean().default(true),
  // Phase-1 additions (optional → backward compatible):
  asked_question_id: z.string().nullable().default(null),
  extraction_ready: z.boolean().default(false),
  updated_state: ConversationStateSchema.nullable().default(null),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
  pseudonymization_metadata: PseudonymizationMetaSchema.nullable().default(null),
});
export type ProfilingTurnOutput = z.infer<typeof ProfilingTurnOutputSchema>;
