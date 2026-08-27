import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  ADMIN_SKILL_REVIEW_TIERS,
  SKILL_CANDIDATE_ACTIONS,
  SKILL_CANDIDATE_CONFIDENCE_BANDS,
  SKILL_CANDIDATE_SOURCE_TYPES,
  SKILL_CANDIDATE_STATUSES,
} from "./skill-discovery-vocabulary";

/**
 * The skill-discovery review-queue data layer (#1260) — the portal's read seam onto
 * `GET /admin/skill-discovery`, `GET /admin/skill-discovery/metrics` and
 * `GET /admin/skill-discovery/:id`. Mirrors `apps/api/src/admin/admin-skill-discovery.dto.ts`
 * by hand, exactly as `lib/feedback.ts` mirrors its own API — this portal takes no workspace
 * dependency on `apps/api` (CLAUDE.md invariant #9).
 *
 * The DECISION write (`POST .../decision`) is NOT here. It is a Server Action colocated with
 * the detail route (`app/(portal)/skills/discovery/[id]/actions.ts`), the same split
 * `workers/[id]/actions.ts` draws against `lib/entities.ts` — a read seam and a governed
 * mutation are different lifecycles, and this file stays a pure read layer.
 *
 * ── WHAT THIS SURFACE MUST NEVER SERVE ──────────────────────────────────────────────────
 * No cosine score, no vector, no embedding model name — `AdminSkillRelatedSkill` on the wire
 * has no `score` key by construction, and neither does the schema below. A relation, a
 * strength and a sentence are what a reviewer gets; `lib/skill-discovery-vocabulary.ts` is
 * where those are translated.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Vocabulary enums, as zod — narrows an unrecognised value to a parse failure for the
// CHECK-backed columns, exactly the house rule `admin-skill-discovery.dto.ts` states: a
// CHECK-backed column gets a union, a plain `text` column gets `z.string()`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const statusSchema = z.enum(SKILL_CANDIDATE_STATUSES);
const actionSchema = z.enum(SKILL_CANDIDATE_ACTIONS);
const bandSchema = z.enum(SKILL_CANDIDATE_CONFIDENCE_BANDS);
const sourceTypeSchema = z.enum(SKILL_CANDIDATE_SOURCE_TYPES);
const tierSchema = z.enum(ADMIN_SKILL_REVIEW_TIERS);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery — the queue
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One queue row. Mirrors `AdminSkillDiscoveryListItem` field for field. */
export const skillDiscoveryListItemSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  cluster_key: z.string(),
  normalized_phrase: z.string(),
  proposed_skill_name: z.string().nullable(),
  /** `text`, no DB CHECK — rendered through `phraseClassLabel`, which falls back to the raw code. */
  phrase_class: z.string(),
  trade_family: z.string().nullable(),
  source_alias_count: z.number(),
  source_domain_count: z.number(),
  proposed_action: actionSchema,
  confidence_band: bandSchema,
  status: statusSchema,
  /** DERIVED, not stored — see `SKILL_TIER_DERIVED_NOT_STORED` on the API side. Never cached
   * as an attribute of the row beyond this one response. */
  review_tier: tierSchema,
  has_strong_match: z.boolean(),
  related_skill_count: z.number(),
  /** Opaque admin id, or null while undecided. Never a name — this portal's identity egress
   * stays on the separate, reason-gated `reveal_pii` path and nothing here goes near it. */
  reviewer_admin_id: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  /** Null on an `approved_create` row until the offline corpus chain mints the skill — the
   * honest answer to "did this approval ever ship?", not a bug to work around. */
  resulting_skill_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SkillDiscoveryListItem = z.infer<typeof skillDiscoveryListItemSchema>;

/** `{ items, nextCursor }` — the entity convention. Declared here for the same reason
 * `lib/feedback.ts` declares its own: `pageOf` is private to `lib/entities.ts`. */
export const skillDiscoveryPageSchema = z.object({
  items: z.array(skillDiscoveryListItemSchema),
  nextCursor: z.string().nullable(),
});
export type SkillDiscoveryPage = z.infer<typeof skillDiscoveryPageSchema>;

export const ADMIN_SKILL_DISCOVERY_SORTS = ["newest", "oldest"] as const;
export type AdminSkillDiscoverySort = (typeof ADMIN_SKILL_DISCOVERY_SORTS)[number];

/**
 * Filters the list route accepts. Mirrors `AdminSkillDiscoveryQuerySchema`. Every value is a
 * RAW string forwarded as-is (never narrowed here): the server's schema is `.strict()`, so a
 * hand-edited or stale value must travel and earn an honest 400 this page renders as a
 * refusal — dropping it would show the WHOLE queue under a URL that claims a filter.
 */
export interface SkillDiscoveryFilters {
  cursor?: string;
  limit?: number;
  sort?: AdminSkillDiscoverySort;
  /** One or many — `?status=pending&status=needs_review` is the undecided view, not one value. */
  status?: string[];
  tier?: string;
  band?: string;
  proposedAction?: string;
  tradeFamily?: string;
  sourceType?: string;
  runId?: string;
  clusterKey?: string;
  phrase?: string;
  createdFrom?: string;
  createdTo?: string;
}

/**
 * A local query-string builder rather than `lib/entities.ts`'s `qs` — that helper has no
 * repeated-key support, and `status` here is legitimately multi-valued (`skillDiscoveryQs`
 * repeats `status=` once per value, never joins them with a comma the server would read as one
 * literal status). Every other rule `qs` uses is kept: undefined/null/empty-string are
 * skipped, never forwarded as `?field=`.
 */
export function skillDiscoveryQs(filters: SkillDiscoveryFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v !== undefined && v !== null && v !== "") params.append(key, v);
      continue;
    }
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function listSkillDiscovery(f: SkillDiscoveryFilters = {}): Promise<SkillDiscoveryPage> {
  return adminFetch(`/admin/skill-discovery${skillDiscoveryQs(f)}`, {
    schema: skillDiscoveryPageSchema,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/:id — one candidate, in full
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Mirrors `AdminSkillRelatedSkill`. NO `score` key — see the module header. */
export const skillRelatedSkillSchema = z.object({
  skill_id: z.string(),
  skill_label: z.string(),
  /** `string`, not the union — `relation` has no DB CHECK, so the vocabulary is closed in
   * TypeScript only. `relationLabel()` (vocabulary module) falls back to the raw code. */
  relation: z.string(),
  relation_label: z.string(),
  strength: z.enum(["strong", "weak"]),
  strength_label: z.string(),
  evidence: z.string(),
  rank: z.number(),
});
export type SkillRelatedSkill = z.infer<typeof skillRelatedSkillSchema>;

/** Mirrors `AdminSkillCandidateSource` — see its header for the privacy posture of `original_text`. */
export const skillCandidateSourceSchema = z.object({
  source_type: sourceTypeSchema,
  source_id: z.string(),
  original_text: z.string(),
  normalized_text: z.string(),
  job_domain_id: z.string().nullable(),
});
export type SkillCandidateSource = z.infer<typeof skillCandidateSourceSchema>;

const sourceTypeCountSchema = z.object({ key: sourceTypeSchema, count: z.number() });

/** Mirrors `AdminSkillCandidateProvenance` — the frozen block. Read-only, always. */
export const skillCandidateProvenanceSchema = z.object({
  run_id: z.string(),
  cluster_key: z.string(),
  classifier_rule: z.string(),
  phrase_class: z.string(),
  occupation_heads: z.array(z.string()),
  evidence_tokens: z.array(z.string()),
  embedding_status: z.enum(["reused", "needs_embedding", "not_required"]),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  corpus_fingerprint: z.string(),
  provenance_digest: z.string(),
});
export type SkillCandidateProvenance = z.infer<typeof skillCandidateProvenanceSchema>;

/** One candidate in full — the review screen. Extends the list row, per the API's own convention. */
export const skillDiscoveryDetailSchema = skillDiscoveryListItemSchema.extend({
  phrase_class_label: z.string(),
  proposed_description: z.string().nullable(),
  /** Composed from stored columns only — never an LLM sentence explaining a decision it may
   * not make (CLAUDE.md §3). Rendered verbatim, never re-derived here. */
  rationale: z.string(),
  sources: z.array(skillCandidateSourceSchema),
  source_type_counts: z.array(sourceTypeCountSchema),
  /** EVERY competing match, best first by `rank` — never just the top one. */
  related_skills: z.array(skillRelatedSkillSchema),
  suggested_aliases: z.array(z.string()),
  review_reason: z.string().nullable(),
  provenance: skillCandidateProvenanceSchema,
});
export type SkillDiscoveryDetail = z.infer<typeof skillDiscoveryDetailSchema>;

export function getSkillDiscoveryCandidate(id: string): Promise<SkillDiscoveryDetail> {
  return adminFetch(`/admin/skill-discovery/${encodeURIComponent(id)}`, {
    schema: skillDiscoveryDetailSchema,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/metrics — the dashboard tiles
// ═══════════════════════════════════════════════════════════════════════════════════════════

const countBucket = <T extends z.ZodTypeAny>(key: T) =>
  z.object({ key, count: z.number() });

/**
 * Mirrors `AdminSkillDiscoveryMetrics`. EVERY breakdown is densified server-side (every enum
 * member, zeros included) — this page must render zero counts, never treat an absent bucket
 * and a zero one as the same thing to omit.
 */
export const skillDiscoveryMetricsSchema = z.object({
  run_id: z.string().nullable(),
  total: z.number(),
  /** `pending` + `needs_review` — the queue's real size. `deferred` is NOT counted here. */
  awaiting_decision: z.number(),
  deferred: z.number(),
  by_status: z.array(countBucket(statusSchema)),
  by_band: z.array(countBucket(bandSchema)),
  by_proposed_action: z.array(countBucket(actionSchema)),
  /** Derived, not stored — `tier_basis` below is the marker that says so. */
  by_tier: z.array(countBucket(tierSchema)),
  oldest_awaiting_created_at: z.string().nullable(),
  tier_basis: z.string(),
});
export type SkillDiscoveryMetrics = z.infer<typeof skillDiscoveryMetricsSchema>;

export function getSkillDiscoveryMetrics(runId?: string): Promise<SkillDiscoveryMetrics> {
  const q = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return adminFetch(`/admin/skill-discovery/metrics${q}`, { schema: skillDiscoveryMetricsSchema });
}
