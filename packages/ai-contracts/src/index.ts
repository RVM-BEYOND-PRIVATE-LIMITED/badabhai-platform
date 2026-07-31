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
  // Issue #423 — where the worker IS, kept separate from where they WANT to work.
  // The interview engine has always treated these as distinct topics
  // (question_bank.py: "current AND preferred location, never conflated"), but the
  // legacy shape had nowhere to put the current city, so `_build_legacy` prepended it
  // to `preferred_cities` — turning "I live in Pune" into "I want to work in Pune".
  //
  // ADDITIVE + defaulted → backward compatible: rows written before this field exist
  // parse fine and keep `current_city: null`, which is why every consumer reads
  // `current_city ?? preferred_cities[0]` rather than switching outright. Mirrors the
  // Pydantic LocationPreference in contracts.py (§7 parity).
  current_city: z.string().nullable().default(null),
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
  // Q14 (ADR-0030 OQ#3, decided 2026-07-16): worker-confirmed RAW skill labels
  // (e.g. "MIG welding"), rendered on the résumé alongside the canonical ids.
  // Populated from WorkerProfileDraft.skills by the AI service's /profile/extract
  // and CERTIFIED CLEAN AT REST there (hygiene clamp + pseudonymize certification
  // — a blocked/masked/altered label never persists), then RE-certified at the
  // résumé boundary (SG-2). TS consumers (PDF render, payer disclosure, mock
  // fallback) may therefore render snapshot labels without their own gate.
  // NEVER canonical ids, NEVER used for matching/ranking. Additive (default []
  // → old rows unchanged). Mirrors apps/ai-service/app/contracts.py.
  skill_labels: z.array(z.string()).default([]),
  machines: z.array(z.string()).default([]),
  // #499 — the worker's education + certifications, carried from the rich draft
  // so the résumé (resume_text + rendered PDF) can show them. The interview
  // ALWAYS asks both (MUST_ASK_TOPICS), and they are captured on the rich
  // WorkerProfileDraft; they were being DROPPED at the rich→legacy boundary,
  // leaving the templates' "Education & Certifications" section empty. PII-free
  // by the same rule as skills/machines (qualification/credential strings, not
  // an employer or identity). Additive (default [] → old snapshots parse
  // unchanged, invariant #8). Mirrors apps/ai-service/app/contracts.py.
  education: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  // Highest academic level ("10th", "12th", "ITI", "Diploma", "B.Tech", …) and the
  // stream/branch ("Electronics", "Mechanical", …). DISTINCT from the `education`
  // list above (which holds ITI/diploma/training MENTIONS) and from `certifications`.
  // PII-free by the same rule as `education` (qualification labels, not identity).
  // Additive + defaulted (null → old snapshots parse unchanged, invariant #8).
  // Mirrors apps/ai-service/app/contracts.py.
  education_level: z.string().nullable().default(null),
  education_field: z.string().nullable().default(null),
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
  // The model's canonicalized role id (one of canonical_roles.ROLE_IDS or null).
  // Additive (default null → backward compatible); VALIDATED against the closed
  // set before use. Mirrors the Pydantic WorkerProfileDraft in contracts.py.
  canonical_role_id: z.string().nullable().default(null),
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
  // State-level location, captured when the worker names a state (e.g. "Bihar")
  // rather than a specific city. Additive (default null → backward compatible).
  current_state: z.string().nullable().default(null),
  preferred_locations: z.array(z.string()).default([]),
  relocation_willingness: z.boolean().nullable().default(null),
  current_salary: z.number().int().nonnegative().nullable().default(null),
  expected_salary: z.number().int().nonnegative().nullable().default(null),
  availability: z.enum(["immediate", "notice_period", "not_looking", "unknown"]).default("unknown"),
  education: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  // Highest academic level ("10th", "12th", "ITI", "Diploma", "B.Tech", …) and the
  // stream/branch ("Electronics", "Mechanical", …). DISTINCT from the `education`
  // list above and from `certifications` — kept untouched. PII-free qualification
  // labels. Additive + defaulted (null → backward compatible). Mirrors the Pydantic
  // WorkerProfileDraft in contracts.py.
  education_level: z.string().nullable().default(null),
  education_field: z.string().nullable().default(null),
  confidence_score: z.number().min(0).max(1).default(0),
  missing_fields: z.array(z.string()).default([]),
  clarification_questions: z.array(z.string()).default([]),
  // Advisory adjacency flag: set (e.g. "outside_cnc_vmc_scope") when the profile
  // canonicalizes to nothing matchable in the CNC/VMC taxonomy, so it is marked
  // adjacent rather than silently half-empty. Additive (default null). Advisory
  // ONLY — never used to rank/reject a worker.
  unmatchable_reason: z.string().nullable().default(null),
});
export type WorkerProfileDraft = z.infer<typeof WorkerProfileDraftSchema>;

// ---------------------------------------------------------------------------
// Job-posting chat (ADR-0035) — the payer-facing sibling of the profiling
// contracts above. Mirrored field-for-field in apps/ai-service/app/contracts.py
// and pinned by the shared golden fixture __fixtures__/job-posting-chat.keys.json,
// which BOTH suites assert against (Pydantic silently drops unknown request keys,
// so a one-sided change is otherwise green on both sides).
// ---------------------------------------------------------------------------

/** The five shipped vacancy bands (ADR-0012). A posting is BANDED, never counted. */
const vacancyBand = z.enum(["1", "2-5", "6-10", "11-25", "25+"]);
/** The closed `jobs.shift` enum (packages/db schema.ts jobs_shift_chk). */
const jobShift = z.enum(["day", "night", "rotational"]);

// Caps mirror apps/api/src/job-postings/job-postings.dto.ts so a draft the AI
// service emits can never be one the publish DTO would reject.
const JP_LABEL_MAX = 200;
const JP_DESCRIPTION_MAX = 2000;

/**
 * Server-computed job-posting interview progress. Mirrors ConversationStateSchema's
 * shape. Holds POSTING signals only (role title, city, band, pay figures) — never
 * payer identity, and never the payer's organisation name, which this chat does not
 * ask for and never receives (ADR-0035 §Decision 3).
 */
export const JobPostingChatStateSchema = z.object({
  /**
   * Reserved trade seam. The job-posting bank is deliberately NOT split by trade
   * (the questions are identical across trades — see the AI service's
   * job_posting_chat/question_bank.py), so this is carried and passed to
   * `topics_for()` but does not branch today. Present so a future trade-specific
   * bank needs no contract change.
   */
  trade_hint: z.string().nullable().default(null),
  turn_count: z.number().int().nonnegative().default(0),
  answered_topics: z
    .array(
      z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z_]+$/, "topic_id must be lowercase slug ([a-z_]+)"),
    )
    .default([]),
  asked_question_ids: z.array(z.string()).default([]),
  collected: z.record(z.string(), z.unknown()).default({}),
  /** CONSECUTIVE clarify re-serves of the same question (engine-bounded at 2). */
  clarify_count: z.number().int().nonnegative().default(0),
  /** Per-topic ASK count — `asked_question_ids` is a dedup set and cannot count. */
  ask_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * ESSENTIAL topics the payer never answered, in ESSENTIAL_TOPICS order. Empty =
   * complete. THIS, not `draft_ready`, is how an incomplete draft is declared.
   * Topic ids only — no PII.
   */
  unanswered_essentials: z.array(z.string()).default([]),
});
export type JobPostingChatState = z.infer<typeof JobPostingChatStateSchema>;

/**
 * The chat's in-progress job posting — the rich-draft precedent set by
 * WorkerProfileDraftSchema, pointed at the demand side.
 *
 * THERE IS DELIBERATELY NO `org_label` FIELD, and adding one is a defect (ADR-0035
 * §Decision 3). `PayerCreateJobPostingSchema` requires `org_label`, but the value is
 * already known server-side on `payers.orgNameEnc` and is decrypted + stamped onto
 * the create call by the NestJS publish step — the same post-hoc interpolation
 * AI-PERSONA-2 uses for a worker's name. The chat never asks for it, so it never
 * enters a payer message, this draft, conversation state, an event payload, or LLM
 * input. Asking would both duplicate data we already hold and invite a payer to type
 * personal contact details next to it.
 */
export const JobPostingDraftSchema = z.object({
  role_title: z.string().max(JP_LABEL_MAX).nullable().default(null),
  /** <= 10 phrases of <= 80 chars — the exact `skillsInput` cap in the publish DTO. */
  skills: z.array(z.string().min(1).max(80)).max(10).default([]),
  location_label: z.string().max(JP_LABEL_MAX).nullable().default(null),
  /** BANDED, never an integer (ADR-0012) — derived via `bandForCount` boundaries. */
  vacancy_band: vacancyBand.nullable().default(null),
  /** Monthly pay in whole rupees. Shapes match jobs.pay_min / jobs.pay_max. */
  pay_min: z.number().int().nonnegative().nullable().default(null),
  pay_max: z.number().int().nonnegative().nullable().default(null),
  shift: jobShift.nullable().default(null),
  benefits: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  description: z.string().max(JP_DESCRIPTION_MAX).nullable().default(null),
  /**
   * DETERMINISTIC coverage ratio (topics with a value / topics in the bank), NOT a
   * model score and never an input to ranking or a publish decision (invariant #4).
   */
  confidence: z.number().min(0).max(1).default(0),
  /**
   * Topic ids still without a value, in bank order. `vacancy` maps to `vacancy_band`
   * and `pay_range` to `pay_min`/`pay_max`; every other id is the draft field name.
   * Ids only — never the values.
   */
  missing_fields: z.array(z.string()).default([]),
  clarification_questions: z.array(z.string()).default([]),
});
export type JobPostingDraft = z.infer<typeof JobPostingDraftSchema>;

export const JobPostingChatOpeningInputSchema = z.object({
  trade_hint: z.string().nullable().optional(),
});
export type JobPostingChatOpeningInput = z.infer<typeof JobPostingChatOpeningInputSchema>;

/** Deliberately just the string — no model call, and no payer/org identity at all. */
export const JobPostingChatOpeningOutputSchema = z.object({
  opening_text: z.string(),
});
export type JobPostingChatOpeningOutput = z.infer<typeof JobPostingChatOpeningOutputSchema>;

/**
 * One payer turn. Mirrors ProfilingTurnInputSchema with one deliberate omission:
 * there is NO `history` field. The profiling input keeps one for caller compatibility
 * and then ignores it (COST-3 — the chat turn is stateless because the engine already
 * chose the question locally). A new contract does not inherit that dead weight, and
 * omitting it makes re-sending a transcript impossible rather than merely discouraged.
 */
export const JobPostingChatTurnInputSchema = z.object({
  session_id: z.string().min(1),
  /** OPAQUE payer reference for spend attribution — never a raw payer identity. */
  payer_ref: z.string().min(1).optional(),
  language: languageCode.optional(),
  message_text: z.string().min(1),
  trade_hint: z.string().nullable().optional(),
  conversation_state: JobPostingChatStateSchema.nullable().optional(),
  /**
   * Reserved for the rephrase seam. No LLM call is made on this route today, so this
   * is inert; it is in the frozen contract so turning the seam on is not a contract
   * change.
   */
  real_call_allowed: z.boolean().optional(),
});
export type JobPostingChatTurnInput = z.infer<typeof JobPostingChatTurnInputSchema>;

/**
 * One engine turn. Mirrors ProfilingTurnOutputSchema.
 *
 * `suggested_answers` is profiling's `suggested_followups` under an honest name:
 * that field's own docstring states it carries ANSWERS to the question just asked,
 * never follow-up questions, because a tapped chip is sent verbatim as the payer's
 * message. A new contract with two client teams building against it gets the
 * accurate name.
 *
 * `draft`/`updated_state` are nullable and are BOTH null on a blocked turn — nothing
 * was parsed, so the caller keeps whatever it had stored.
 */
export const JobPostingChatTurnOutputSchema = z.object({
  reply_text: z.string(),
  blocked: z.boolean().default(false),
  blocked_reason: z.string().nullable().default(null),
  suggested_answers: z.array(z.string()).default([]),
  /** Always true today — this route makes zero LLM calls on every path. */
  is_mock: z.boolean().default(true),
  asked_question_id: z.string().nullable().default(null),
  /**
   * The interview is complete: every essential answered and every must-ask topic
   * raised. The publish step still re-validates against PayerCreateJobPostingSchema.
   */
  draft_ready: z.boolean().default(false),
  draft: JobPostingDraftSchema.nullable().default(null),
  updated_state: JobPostingChatStateSchema.nullable().default(null),
  /** Always null today (no model is called); frozen for the rephrase seam. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
  pseudonymization_metadata: PseudonymizationMetaSchema.nullable().default(null),
});
export type JobPostingChatTurnOutput = z.infer<typeof JobPostingChatTurnOutputSchema>;

// ---------------------------------------------------------------------------
// Skill canonicalization (ADR-0030 / TAX-4) — mirrors contracts.py
// ---------------------------------------------------------------------------
export const SkillCanonicalizationInputSchema = z.object({
  phrase: z.string(),
  domain_id: z.string(),
  lang: z.string().default("en"),
});
export type SkillCanonicalizationInput = z.infer<typeof SkillCanonicalizationInputSchema>;

// Result: an ASSIGNED skill_id (top match >= floor) or UNRESOLVED. No PII. SG-3 /
// LLM-never-invents: skill_id is null unless the vector layer assigned it.
export const SkillCanonicalizationSchema = z.object({
  status: z.enum(["matched", "unresolved"]),
  skill_id: z.string().nullable().default(null),
  score: z.number().nullable().default(null),
});
export type SkillCanonicalization = z.infer<typeof SkillCanonicalizationSchema>;

// ---------------------------------------------------------------------------
// Skill-alias embedding batch (ADR-0030 / TAX-3 fork-B runner seam) — mirrors
// contracts.py. The db-side runner (packages/db embed-skill-aliases.ts) POSTs
// alias-text batches to the ai-service /embeddings/skill-alias endpoint.
// ---------------------------------------------------------------------------
export const SkillAliasEmbedItemSchema = z.object({
  alias_id: z.string(),
  text: z.string(),
});
export type SkillAliasEmbedItem = z.infer<typeof SkillAliasEmbedItemSchema>;

export const SkillAliasEmbedInputSchema = z.object({
  items: z.array(SkillAliasEmbedItemSchema).max(200), // request cap == Pydantic max_length
});
export type SkillAliasEmbedInput = z.infer<typeof SkillAliasEmbedInputSchema>;

// vector null ⇔ blocked (pseudonymize fail-closed) — the runner leaves that row NULL.
export const SkillAliasEmbedResultSchema = z.object({
  alias_id: z.string(),
  vector: z.array(z.number()).nullable().default(null),
  blocked: z.boolean().default(false),
});
export type SkillAliasEmbedResult = z.infer<typeof SkillAliasEmbedResultSchema>;

// `results` may be SHORTER than `items`: budget-stopped or provider-errored items are
// OMITTED (rows stay NULL; a later run resumes). Already-paid embeds are always returned.
export const SkillAliasEmbedOutputSchema = z.object({
  results: z.array(SkillAliasEmbedResultSchema),
  is_mock: z.boolean().default(true),
  model: z.string(),
  // Per-request INR ceiling fired on the REAL path (TD64 interim guard).
  budget_stopped: z.boolean().default(false),
  // Per-item real-provider failures skipped (batch continued).
  errors: z.number().int().nonnegative().default(0),
  estimated_cost_inr: z.number().nonnegative().default(0),
});
export type SkillAliasEmbedOutput = z.infer<typeof SkillAliasEmbedOutputSchema>;

// ---------------------------------------------------------------------------
// Growth-loop clustering (ADR-0030 / TAX-7 — pure compute, human-gated) — mirrors
// contracts.py. The db-side runner (packages/db growth-cluster.ts) POSTs per-domain
// batches of OPEN unresolved_phrase rows (SG-1 pseudonymized text + vectors) and the
// embedded skill_alias anchors to /growth/cluster; the output is REPORT-ONLY — the
// human ratification flow is the only activation path.
// ---------------------------------------------------------------------------
const GROWTH_VECTOR_DIM = 768; // the house embedding dimension

// .finite(): z.number() alone accepts +/-Infinity — the Pydantic side 422s any
// non-finite component (it would silently poison every cosine), so the mirror must too.
const growthVector = z.array(z.number().finite()).length(GROWTH_VECTOR_DIM);

export const GrowthPhraseSchema = z.object({
  id: z.string(),
  phrase: z.string(), // ALREADY pseudonymized at rest (SG-1)
  count: z.number().int().min(1),
  vector: growthVector,
});
export type GrowthPhrase = z.infer<typeof GrowthPhraseSchema>;

export const GrowthAnchorSchema = z.object({
  skill_id: z.string(), // the CLOSED id space — the only id a proposal may carry (SG-3)
  vector: growthVector,
});
export type GrowthAnchor = z.infer<typeof GrowthAnchorSchema>;

export const GrowthClusterInputSchema = z.object({
  domain_id: z.string(),
  phrases: z.array(GrowthPhraseSchema).max(500), // request caps == Pydantic max_length
  anchors: z.array(GrowthAnchorSchema).max(5000),
  min_cluster_size: z.number().int().min(1).nullable().default(null),
  min_total_count: z.number().int().min(1).nullable().default(null),
  cluster_threshold: z.number().min(0).max(1).nullable().default(null),
  band_low: z.number().min(0).max(1).nullable().default(null),
  floor: z.number().min(0).max(1).nullable().default(null),
});
export type GrowthClusterInput = z.infer<typeof GrowthClusterInputSchema>;

// kind=alias → skill_id set (ALWAYS one of the request's anchors — SG-3);
// kind=provisional_skill → skill_id null (NO id is minted here — SG-5).
export const GrowthProposalSchema = z.object({
  kind: z.enum(["alias", "provisional_skill"]),
  skill_id: z.string().nullable().default(null),
  leader_phrase: z.string(),
  member_ids: z.array(z.string()),
  member_phrases: z.array(z.string()),
  total_count: z.number().int(),
  nearest_skill_id: z.string().nullable().default(null),
  nearest_score: z.number().nullable().default(null),
  note: z.string().nullable().default(null),
});
export type GrowthProposal = z.infer<typeof GrowthProposalSchema>;

export const GrowthClusterOutputSchema = z.object({
  proposals: z.array(GrowthProposalSchema),
  phrases_in: z.number().int().nonnegative(),
  clusters_total: z.number().int().nonnegative(),
  clusters_eligible: z.number().int().nonnegative(),
  skipped_below_guards: z.number().int().nonnegative(),
});
export type GrowthClusterOutput = z.infer<typeof GrowthClusterOutputSchema>;

// ---------------------------------------------------------------------------
// Offline skill re-tag plan (ADR-0030 / TAX-9 — pure compute, dry-run first) —
// mirrors contracts.py. The db-side runner (packages/db retag-skills.ts) supplies
// the skill.replaced_by crosswalk + affected rows to /skills/retag-plan and applies
// the returned changes only under --apply. row_ref is an opaque row uuid — no PII.
// ---------------------------------------------------------------------------
export const RetagCrosswalkEntrySchema = z.object({
  deprecated_id: z.string(),
  replaced_by: z.string(),
});
export type RetagCrosswalkEntry = z.infer<typeof RetagCrosswalkEntrySchema>;

export const RetagRowSchema = z.object({
  row_ref: z.string(),
  skill_ids: z.array(z.string()).max(100), // caps == Pydantic max_length
});
export type RetagRow = z.infer<typeof RetagRowSchema>;

export const RetagPlanInputSchema = z.object({
  crosswalk: z.array(RetagCrosswalkEntrySchema).max(1000),
  rows: z.array(RetagRowSchema).max(5000),
});
export type RetagPlanInput = z.infer<typeof RetagPlanInputSchema>;

export const RetagResolvedEntrySchema = z.object({
  deprecated_id: z.string(),
  terminal_id: z.string(),
  hops: z.number().int().min(1),
});
export type RetagResolvedEntry = z.infer<typeof RetagResolvedEntrySchema>;

export const RetagChangeSchema = z.object({
  row_ref: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});
export type RetagChange = z.infer<typeof RetagChangeSchema>;

export const RetagPlanOutputSchema = z.object({
  resolved: z.array(RetagResolvedEntrySchema),
  dropped: z.array(z.string()), // crosswalk ids on a CYCLE — fail-safe, not re-tagged
  changes: z.array(RetagChangeSchema),
  rows_in: z.number().int().nonnegative(),
  rows_changed: z.number().int().nonnegative(),
});
export type RetagPlanOutput = z.infer<typeof RetagPlanOutputSchema>;

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
  // Opaque worker ref (PII-free) → attributes resume spend to the per-user daily
  // cap (TD27), so resume + chat + extraction share one per-user/day budget.
  worker_ref: z.string().min(1).optional(),
});
export type ResumeGenerationInput = z.infer<typeof ResumeGenerationInputSchema>;

export const ResumeGenerationOutputSchema = z.object({
  resume_text: z.string(),
  resume_json: z.record(z.string(), z.unknown()),
  format: z.enum(["text", "json"]).default("text"),
  is_mock: z.boolean().default(true),
});
export type ResumeGenerationOutput = z.infer<typeof ResumeGenerationOutputSchema>;

// ---------------------------------------------------------------------------
// Voice transcription (STT). Input carries only an opaque storage reference;
// output's transcript_text is raw worker free-text — the backend stores it in
// voice_notes and keeps it OUT of events/ai_jobs/logs.
// ---------------------------------------------------------------------------
export const TranscriptionInputSchema = z.object({
  voice_note_id: z.string().min(1).optional(),
  storage_path: z.string().min(1),
  duration_seconds: z.number().nonnegative().nullable().optional(),
  language_code: languageCode.optional(),
  // Optional (AI service defaults to true) → backward compatible input type.
  real_call_allowed: z.boolean().optional(),
  // AI service ALSO translates the transcript to English when true (it defaults to
  // true server-side). Optional here → backward compatible input type.
  translate_to_english: z.boolean().optional(),
  // Opaque worker ref (PII-free) → attributes real STT chunk spend to the TD27
  // per-user daily cap (D-2 chunked path: one 120s note = up to 5 provider calls),
  // so voice + chat + extraction + resume share one budget. Optional → backward
  // compatible. Mirrors contracts.py TranscriptionInput.worker_ref.
  worker_ref: z.string().min(1).optional(),
});
export type TranscriptionInput = z.infer<typeof TranscriptionInputSchema>;

export const TranscriptionOutputSchema = z.object({
  transcript_text: z.string(),
  confidence: z.number().min(0).max(1).default(0),
  language_code: z.string().nullable().default(null),
  /** True when the response came from the mock path (AI_ENABLE_REAL_CALLS=false). */
  is_mock: z.boolean().default(true),
  // Derived English translation (empty when not translated / source already English /
  // translation failed-closed). Raw worker text — stored in voice_notes.transcript_english,
  // kept OUT of events/ai_jobs/logs.
  english_text: z.string().default(""),
});
export type TranscriptionOutput = z.infer<typeof TranscriptionOutputSchema>;
