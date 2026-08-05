import { z } from "zod";

import {
  AICallMetadataSchema,
  ConversationMessageSchema,
  languageCode,
} from "./common";
import { JobDomainMatchSchema } from "./occupation";

// The worker profile: the storage-shaped draft profile, the rich extraction
// draft it is derived from, and the extraction / resume-generation contracts
// that produce and consume them.

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
  // The interview has always treated these as distinct topics — the Resume Field Set
  // keeps `current_city` and `preferred_locations` as two separate REQUIRED fields, for
  // the same reason the persona asks them as two questions ("Abhi kahan rehte hain?" vs
  // "Kaam kahan karna chahte hain?") — but the
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
  /**
   * The RAG job-domain classification. `null` = the pass DID NOT RUN (the flag is off,
   * or the extraction was blocked), which is deliberately distinct from a pass that ran
   * and came back unmatched: the first writes nothing, the second records the reason.
   * Collapsing the two would make a disabled feature indistinguishable from a workforce
   * the catalog cannot describe.
   */
  job_domain_match: JobDomainMatchSchema.nullable().default(null),
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
