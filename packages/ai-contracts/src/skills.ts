import { z } from "zod";

// Skill taxonomy seams (ADR-0030): phrase canonicalization (TAX-4), the alias
// embedding batch (TAX-3), growth-loop clustering (TAX-7) and the offline
// skill re-tag plan (TAX-9).

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
