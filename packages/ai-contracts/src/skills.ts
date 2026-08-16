import { z } from "zod";

import { AICallMetadataSchema } from "./common";

// Skill taxonomy seams (ADR-0030): phrase canonicalization (TAX-4), the alias
// embedding batch (TAX-3), growth-loop clustering (TAX-7) and the offline
// skill re-tag plan (TAX-9).

// ---------------------------------------------------------------------------
// Skill canonicalization (ADR-0030 / TAX-4) — mirrors contracts.py
// ---------------------------------------------------------------------------
/**
 * TWO DOMAIN ID SPACES, EXACTLY ONE PER REQUEST (Phase 1.5 canonicalizer cutover).
 *
 * `domain_id` is the LEGACY 11-slug skill domain ("cnc-machining") that
 * `skill_alias.domain_id` denormalizes. Migration 0076 made that column NULLABLE and
 * demoted it to compatibility metadata, so a canonical skill minted by the taxonomy
 * bootstrap carries no slug at all and is INVISIBLE to a `WHERE domain_id = $1` scan.
 * `job_domain_id` is the canonical `jd_*` id, and it resolves candidates through
 * `job_domain_skill` instead — which is the whole point of the cutover.
 *
 * EXACTLY ONE, ENFORCED — neither is 400, both is 400. This is the rule that matters
 * most in the file: making both optional without the refine would let a caller send
 * neither, and "no domain" must never be allowed to degrade into "search the entire
 * skill vocabulary". A cook would get offered lathe skills. Reject instead.
 *
 * A `.refine` (i.e. a ZodEffects, not a ZodObject) is safe here because nothing calls
 * `.shape`, `.extend`, `.partial` or `.pick` on this schema — verified at cutover; if
 * that ever changes, move the rule to `.superRefine` on the object and re-check.
 */
export const SkillCanonicalizationInputSchema = z
  .object({
    phrase: z.string(),
    /** LEGACY 11-slug skill domain. Optional as of Phase 1.5; still fully supported. */
    domain_id: z.string().optional(),
    /** CANONICAL `jd_*` job domain — candidates come from `job_domain_skill`. */
    job_domain_id: z.string().optional(),
    lang: z.string().default("en"),
  })
  .refine((v) => (v.domain_id === undefined) !== (v.job_domain_id === undefined), {
    message:
      "exactly one of domain_id (legacy skill-domain slug) or job_domain_id (canonical jd_*) is required",
  });
export type SkillCanonicalizationInput = z.infer<typeof SkillCanonicalizationInputSchema>;

// Result: an ASSIGNED skill_id (top match >= floor) or UNRESOLVED. No PII. SG-3 /
// LLM-never-invents: skill_id is null unless the vector layer assigned it.
export const SkillCanonicalizationSchema = z.object({
  status: z.enum(["matched", "unresolved"]),
  skill_id: z.string().nullable().default(null),
  score: z.number().nullable().default(null),
  // #745 — the embed is a PAID provider call and this contract had no way to carry its
  // cost, which is the same root cause #738 fixed for STT: no field ⇒ no emitter could
  // exist ⇒ `WHERE task_type = 'skill_embedding'` returned empty and read as "no spend".
  // Additive + defaulted, so an ai-service that predates the field still parses.
  // null on every path that reached no provider (flag off, ledger block, pseudonymize
  // block); `AiCostRecorder.record` no-ops on null so the caller never branches.
  ai_metadata: AICallMetadataSchema.nullable().default(null),
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
