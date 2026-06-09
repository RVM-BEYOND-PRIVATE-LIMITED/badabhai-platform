import { z } from "zod";

/**
 * @badabhai/ai-contracts — the request/response contracts between the NestJS API
 * and the FastAPI AI service.
 *
 * IMPORTANT: these contracts are mirrored as Pydantic models in
 * `apps/ai-service/app/contracts.py`. Keep the two in sync.
 *
 * PRIVACY: by design these contracts never carry raw worker identity (no phone,
 * full name, address, or employer name). Profiling/extraction inputs are passed
 * through the pseudonymization gateway before any LLM call. Resume generation
 * receives only the structured profile — the backend re-attaches the worker's
 * real name when assembling the final artifact, so the name never reaches the
 * AI service.
 */

const languageCode = z.string().min(2).max(8);

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

// Interview conversation state (profile signals only — never identity PII).
export const ConversationStateSchema = z.object({
  role_family: z.string().default("cnc_vmc"),
  turn_count: z.number().int().nonnegative().default(0),
  answered_topics: z.array(z.string()).default([]),
  asked_question_ids: z.array(z.string()).default([]),
  collected: z.record(z.string(), z.unknown()).default({}),
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
});
export type ProfilingTurnInput = z.infer<typeof ProfilingTurnInputSchema>;

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

// ---------------------------------------------------------------------------
// Draft profile (shared by extraction output and resume input)
// ---------------------------------------------------------------------------
export const ExperienceSchema = z.object({
  total_years: z.number().nonnegative().nullable().default(null),
  summary: z.string().nullable().default(null),
});

export const SalaryExpectationSchema = z.object({
  amount_min: z.number().nonnegative().nullable().default(null),
  amount_max: z.number().nonnegative().nullable().default(null),
  currency: z.string().default("INR"),
  period: z.enum(["monthly", "daily", "yearly"]).default("monthly"),
});

export const LocationPreferenceSchema = z.object({
  preferred_cities: z.array(z.string()).default([]),
  willing_to_relocate: z.boolean().nullable().default(null),
});

export const AvailabilitySchema = z.object({
  status: z.enum(["immediate", "notice_period", "not_looking", "unknown"]).default("unknown"),
  notice_period_days: z.number().int().nonnegative().nullable().default(null),
});

export const DraftProfileSchema = z.object({
  canonical_trade_id: z.string().nullable().default(null),
  canonical_role_id: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  machines: z.array(z.string()).default([]),
  experience: ExperienceSchema.default({}),
  salary_expectation: SalaryExpectationSchema.default({}),
  location_preference: LocationPreferenceSchema.default({}),
  availability: AvailabilitySchema.default({}),
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type DraftProfile = z.infer<typeof DraftProfileSchema>;

// ---------------------------------------------------------------------------
// Rich worker profile draft (the clean messy-text → profile output). Uses
// human-readable labels (e.g. "VMC Operator"); DraftProfile (taxonomy ids) is
// derived from it for backward-compatible storage.
// ---------------------------------------------------------------------------
const knowledgeLevel = z.enum(["none", "basic", "strong", "unknown"]);
const experienceLevel = z.enum(["fresher", "junior", "experienced", "senior", "unknown"]);

export const WorkerProfileDraftSchema = z.object({
  role_family: z.string().default("cnc_vmc"),
  primary_role: z.string().nullable().default(null),
  secondary_roles: z.array(z.string()).default([]),
  machines: z.array(z.string()).default([]),
  controllers: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  experience_years: z.number().nonnegative().nullable().default(null),
  experience_level: experienceLevel.default("unknown"),
  programming_knowledge: knowledgeLevel.default("unknown"),
  setting_knowledge: knowledgeLevel.default("unknown"),
  operation_knowledge: knowledgeLevel.default("unknown"),
  inspection_tools: z.array(z.string()).default([]),
  materials_handled: z.array(z.string()).default([]),
  drawing_reading: z.boolean().nullable().default(null),
  current_city: z.string().nullable().default(null),
  preferred_locations: z.array(z.string()).default([]),
  relocation_willingness: z.boolean().nullable().default(null),
  current_salary: z.number().int().nonnegative().nullable().default(null),
  expected_salary: z.number().int().nonnegative().nullable().default(null),
  availability: z.enum(["immediate", "notice_period", "not_looking", "unknown"]).default("unknown"),
  education: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  confidence_score: z.number().min(0).max(1).default(0),
  missing_fields: z.array(z.string()).default([]),
  clarification_questions: z.array(z.string()).default([]),
});
export type WorkerProfileDraft = z.infer<typeof WorkerProfileDraftSchema>;

// ---------------------------------------------------------------------------
// Profile extraction
// ---------------------------------------------------------------------------
export const ProfileExtractionInputSchema = z
  .object({
    worker_ref: z.string().min(1).optional(),
    language: languageCode.optional(),
    transcript: z.string().min(1).optional(),
    messages: z.array(ConversationMessageSchema).optional(),
    role_family: z.string().optional(), // Phase-1 addition (AI service defaults it)
  })
  .refine((d) => Boolean(d.transcript) || (d.messages?.length ?? 0) > 0, {
    message: "Provide either `transcript` or a non-empty `messages` array",
  });
export type ProfileExtractionInput = z.infer<typeof ProfileExtractionInputSchema>;

export const ProfileExtractionOutputSchema = z.object({
  profile: DraftProfileSchema,
  blocked: z.boolean().default(false),
  blocked_reason: z.string().nullable().default(null),
  is_mock: z.boolean().default(true),
  // Phase-1 additions (optional → backward compatible):
  extraction_status: z.enum(["completed", "blocked"]).default("completed"),
  worker_profile_draft: WorkerProfileDraftSchema.nullable().default(null),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ProfileExtractionOutput = z.infer<typeof ProfileExtractionOutputSchema>;

// ---------------------------------------------------------------------------
// Resume generation (placeholder; no name reaches the AI service)
// ---------------------------------------------------------------------------
export const ResumeGenerationInputSchema = z.object({
  profile: DraftProfileSchema,
  language: languageCode.optional(),
});
export type ResumeGenerationInput = z.infer<typeof ResumeGenerationInputSchema>;

export const ResumeGenerationOutputSchema = z.object({
  resume_text: z.string(),
  resume_json: z.record(z.string(), z.unknown()),
  format: z.enum(["text", "json"]).default("text"),
  is_mock: z.boolean().default(true),
});
export type ResumeGenerationOutput = z.infer<typeof ResumeGenerationOutputSchema>;
