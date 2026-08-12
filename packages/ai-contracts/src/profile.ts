import { z } from "zod";

import {
  AICallMetadataSchema,
  ConversationMessageSchema,
  languageCode,
} from "./common";
import { JobDomainMatchSchema } from "./occupation";
// One-way edge: `oie.ts` imports nothing from this file, so carrying the experience entry
// here does not close a cycle. It lives in `oie.ts` because the interview produces it.
import { ExperienceEntrySchema } from "./oie";

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

/**
 * ── THE RÉSUMÉ CONTAINER ──────────────────────────────────────────────────────────────
 *
 * The LLM-led interview's Phase C object, stored as the model produced it. This is the
 * résumé's ONLY input; `DraftProfile` below is no longer read on that path.
 *
 * WHY A SECOND SHAPE EXISTS AT ALL. `DraftProfile` is a storage shape inherited from the
 * deterministic pack era: flat model values arrive and get scattered into `salary_expectation
 * {}`, `location_preference{}`, `availability{}` alongside eight taxonomy fields the LLM path
 * never fills. Rendering a résumé from it meant reassembling, per field, a thing the model had
 * already handed us whole — and every reassembly step was a place a value could be dropped,
 * outvoted or reshaped. Four of nine keys were being discarded that way before #812.
 *
 * SO THE RULE HERE IS: NO MERGE, NO PRECEDENCE, NO DERIVATION. These keys are the Phase C
 * response, one-for-one, in its own order. A reader can diff this against the Langfuse
 * assistant message and expect equality. That property is the entire point of the container
 * and it is what makes the résumé debuggable; anything that "improves" a value on the way in
 * destroys it.
 *
 * DELIBERATELY NARROWER THAN THE ANSWER MAP. `FIELD_CROSSWALK` types fifteen fields; this
 * holds the nine the model produces. Education, certifications, languages, tools and
 * relocation are captured by the template tail and live on `DraftProfile` — they are NOT
 * rendered from here, and that is an accepted, temporary loss (owner decision 2026-08-12):
 * the pipeline is being proven end-to-end on a narrow field set first, and Phase A plus the
 * tail widen afterwards. When they do, the fields land HERE rather than being merged in.
 *
 * NOT USED FOR MATCHING OR RANKING, ever. Those read `DraftProfile`'s canonical ids and
 * `worker_attributes`, which are taxonomy-validated. This container is free text the model
 * wrote (§3: AI never owns business decisions), so it may describe a worker but must never
 * rank one.
 *
 * PII: every string here already passed the ai-service's pseudonymize certification —
 * `_certified()` drops a whole experience whose composed prose trips the gateway, and skills
 * are filtered element-wise (`routers/profiling.py`). `ExperienceEntrySchema.strict()` is what
 * keeps an employer name out of a column rather than a prompt rule (§2).
 */
export const ResumeProfileSchema = z.object({
  domain_label: z.string().max(120).nullable().default(null),
  role_label: z.string().max(120).nullable().default(null),
  skills: z.array(z.string().max(120)).default([]),
  experiences: z.array(ExperienceEntrySchema).default([]),
  shift: z.string().max(40).nullable().default(null),
  current_city: z.string().max(120).nullable().default(null),
  preferred_locations: z.array(z.string().max(120)).default([]),
  // THE MODEL'S OWN VOCABULARY, KEPT. `AvailabilitySchema.status` uses a different closed set
  // ("notice_period"), and translating on the way in would break the diff-against-the-trace
  // property this container exists for. The renderer humanises it at the edge instead, which
  // is where a presentation concern belongs.
  availability: z.string().max(40).nullable().default(null),
  expected_salary: z.number().nonnegative().nullable().default(null),
});
export type ResumeProfile = z.infer<typeof ResumeProfileSchema>;

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
  // The LLM-led interview's multi-job history. ADDITIVE AND DEFAULTED, so every snapshot ever
  // written parses unchanged (invariant #8) — and it lands HERE rather than on the rich draft
  // because `resume.service.ts` parses `rawProfile` through `DraftProfileSchema` and never
  // reads `richProfileDraft`. On the rich draft these entries would be persisted and then
  // silently absent from the résumé they exist to fill.
  //
  // `experience.total_years` above is NOT replaced. It stays the aggregate that matching and
  // ranking already read; this is the narrative, and the two answer different questions.
  //
  // NO EMPLOYER NAMES — enforced by `ExperienceEntrySchema.strict()`, not by convention.
  experiences: z.array(ExperienceEntrySchema).default([]),
  // ── THE THREE PHASE C KEYS THAT HAD NOWHERE TO LAND ───────────────────────────────
  //
  // `InterviewExtractOutput` returns nine data keys and the extract prompt asks the model for
  // all nine by name. Five had a destination on this schema; `experiences` has one above. These
  // three did not, so the processor's merge read them ZERO times — prompted for, billed for,
  // validated, carried across the wire, then dropped on the floor. The Langfuse assistant
  // response and the stored profile disagreed on four of nine keys and nothing said so.
  //
  // ADDITIVE + DEFAULTED, so every snapshot ever written parses unchanged (invariant #8), and
  // `raw_profile` is `jsonb` — no migration, no column, nothing to roll back (§10).
  //
  // THEY LAND HERE, NOT ON THE RICH DRAFT, for the reason `experiences` does: `resume.service.ts`
  // parses `rawProfile` through THIS schema and never reads `richProfileDraft`. On the rich draft
  // they would be persisted and still absent from the résumé.
  //
  // BOUNDED LENGTHS BECAUSE THIS IS MODEL OUTPUT (§11). A runaway completion must not be able to
  // write unbounded text into a jsonb column; the bounds are generous enough that no honest
  // answer is clipped.
  //
  // PII-free by the same rule as `skills`/`education`: a trade name, a job title and a shift
  // descriptor are occupational vocabulary, not identity — and the ai-service has already
  // re-certified every composed string through the pseudonymizer before this point.
  domain_label: z.string().max(120).nullable().default(null),
  role_label: z.string().max(120).nullable().default(null),
  shift: z.string().max(40).nullable().default(null),
  salary_expectation: SalaryExpectationSchema.default({}),
  location_preference: LocationPreferenceSchema.default({}),
  availability: AvailabilitySchema.default({}),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /**
   * THE RÉSUMÉ CONTAINER, CARRIED INSIDE THIS ONE.
   *
   * NESTED RATHER THAN GIVEN ITS OWN COLUMN, deliberately. `raw_profile` is `jsonb`, so this
   * costs no migration and no production column (§10 prefers additive; §3 forbids removing
   * one). It also means it rides to the résumé for free: `resumes.source_profile_snapshot`
   * already snapshots the whole `DraftProfile`, so the renderer receives the container without
   * a second read, a second write, or a join that could disagree.
   *
   * `null` IS THE HONEST VALUE FOR EVERY PROFILE WRITTEN BEFORE THIS, and for every profile
   * the LLM-led interview did not produce — a deterministic-only extraction has no Phase C
   * object and must not have one invented. The renderer treats null as "fall back to the old
   * path", which is what keeps existing résumés rendering exactly as they do today
   * (invariant #8).
   *
   * THE TWO SHAPES CAN DRIFT, and the rule that stops it mattering: this is authoritative for
   * the RÉSUMÉ and nothing else; the fields above stay authoritative for matching, ranking and
   * `worker_attributes`. Neither is derived from the other, so neither can silently corrupt
   * the other — they are two records of the same interview written for two different readers.
   */
  resume_profile: ResumeProfileSchema.nullable().default(null),
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
   * #745 — the embeds the TAX-4 canonicalization pass paid for. ONE ENTRY PER EMBED.
   *
   * `ai_metadata` above is the EXTRACTION call alone. The canonicalization pass that runs
   * after it makes a second set of billable provider calls (one per skill label), and they
   * had no way home: `canonicalize_labels` returned ids and unresolved labels only. The
   * first cut of #745 wired `/skills/canonicalize` (the job-posting side) and left this
   * one, so `WHERE task_type = 'skill_embedding'` returned only part of the spend — and a
   * partial ledger reads as a complete one, which is worse than an empty one.
   *
   * A LIST because the count is the point: a 10-label pass is 10 billable embeds and a
   * per-pass record would under-report it tenfold. EMPTY on every path that reached no
   * provider (flag off, spend-ledger block, blocked extraction) — which means "nothing was
   * attempted", never "the embeds were free". Additive + defaulted, so an ai-service that
   * predates the field still parses (§3).
   */
  skill_embedding_metadata: z.array(AICallMetadataSchema).default([]),
  /**
   * The RAG job-domain classification. `null` = the pass DID NOT RUN (the flag is off,
   * or the extraction was blocked), which is deliberately distinct from a pass that ran
   * and came back unmatched: the first writes nothing, the second records the reason.
   * Collapsing the two would make a disabled feature indistinguishable from a workforce
   * the catalog cannot describe.
   */
  job_domain_match: JobDomainMatchSchema.nullable().default(null),
  /**
   * Why this extraction is degraded, when it is — the field that lets a caller tell an
   * ai-service OUTAGE from a worker who genuinely said nothing.
   *
   * Both arrive as `blocked: false` with an empty `profile`, and `is_mock` cannot separate
   * them: the ai-service returns `is_mock = not real_call`, so every healthy extraction under
   * the committed `AI_ENABLE_REAL_CALLS=false` default carries `is_mock: true` too. Without
   * this field there was no value in the object capable of telling the two apart, and an
   * outage read as a wave of workers with nothing to say.
   *
   * `extract_service_unreachable` is authored by `AiService` itself (the request never left
   * the process, so no server could report it). Codes originating on the ai-service side
   * travel here unchanged. `null` on every healthy response.
   *
   * ADDITIVE and DEFAULTED, so invariant #8 holds: an older ai-service that has never heard
   * of this field still parses, landing on `null` — the same value it would have sent.
   * Mirrors `TranscriptionOutputSchema.error_code`, which exists for the identical reason.
   */
  error_code: z.string().nullable().default(null),
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
  // #745 — `router.run` always produced this on the résumé route; the route dropped it,
  // so real resume spend reached no ledger. Additive + defaulted (the §3 discipline #738
  // used). null on the pseudonymize-blocked path, which completes from the LOCAL
  // deterministic résumé without calling a provider.
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type ResumeGenerationOutput = z.infer<typeof ResumeGenerationOutputSchema>;
