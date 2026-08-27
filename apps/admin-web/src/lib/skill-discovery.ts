import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  ADMIN_SKILL_REQUIREMENTS,
  ADMIN_SKILL_REVIEW_TIERS,
  ADMIN_SKILLS_PAGE_DEFAULT,
  SKILL_CANDIDATE_ACTIONS,
  SKILL_CANDIDATE_CONFIDENCE_BANDS,
  SKILL_CANDIDATE_SOURCE_TYPES,
  SKILL_CANDIDATE_STATUSES,
} from "./skill-discovery-vocabulary";

/**
 * The skill-discovery review-queue data layer (#1260, extended #1280) — the portal's read seam
 * onto `GET /admin/skill-discovery`, `GET /admin/skill-discovery/metrics`,
 * `GET /admin/skill-discovery/groups`, `GET /admin/skill-discovery/:id`,
 * `GET /admin/skill-discovery/:id/audit` and `GET /admin/skills`. Mirrors
 * `apps/api/src/admin/admin-skill-discovery.dto.ts` by hand, exactly as `lib/feedback.ts`
 * mirrors its own API — this portal takes no workspace dependency on `apps/api` (CLAUDE.md
 * invariant #9). `apps/api/src/admin/admin-skill-discovery.contract-parity.test.ts` reads this
 * file (and its sibling vocabulary file) as data and fails the BACKEND'S build if the mirror
 * drifts — see that file's own header before "fixing" a failure here.
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
 *
 * ── #1280 CONTRACT CORRECTIONS, APPLIED HERE (see the issue's own correction comment) ────
 * The detail schema does NOT read `confidence` or a top-level `classifier_rule` / `model` /
 * `corpus_fingerprint` / `provenance_digest` — those never existed on the wire, or moved under
 * `provenance` — and this file never declared them. `group.undecided` sorting is a client
 * concern, never assumed server-side (see `page.tsx`'s sort toggle). `current` on the audit
 * response is modelled non-nullable, matching the corrected contract. `provenance.model` /
 * `provenance.prompt_version` DO parse — the DTO serves them — even though the review screen
 * chooses not to render them (see `[id]/page.tsx`'s own header on that choice).
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
  /**
   * THE SCOPE OF A `create` APPROVAL (#1280) — the trades it named, empty until one is
   * recorded and never populated by any other decision kind. Served so a second reviewer sees
   * WHAT a `create` was approved for, not only that it was approved — a wrong trade produces a
   * skill on the wrong picker rather than an obviously broken one.
   */
  approved_job_domain_ids: z.array(z.string()),
  /** `required`/`preferred` for those trades, or the conservative default when unset. */
  approved_requirement: z.enum(ADMIN_SKILL_REQUIREMENTS),
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/groups — the review BATCHES (#1280)
//
// Replaces the degraded client-side grouping this screen shipped with in #1260 (grouping by
// `trade_family` alone, within one server page — see `page.tsx`'s prior header for the finding
// this route was raised to close). Real batches now: ~3,009 review groups over the full
// 6,673-candidate population, not a family split within 50 rows.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The SAME FILTERS as the queue, minus `cursor`/`limit`/`sort` — mirrors
 * `AdminSkillDiscoveryGroupsQuerySchema`. A group promises its member list is complete for the
 * applied filters and the anchor is computed over the WHOLE matching population, so a page
 * cannot honestly serve one: there is no cursor here and never should be.
 */
export type SkillDiscoveryGroupsFilters = Omit<SkillDiscoveryFilters, "cursor" | "limit" | "sort">;

/**
 * One review batch — mirrors `AdminSkillReviewGroup`.
 *
 * ── A GROUP IS A LENS, NOT A MERGE ────────────────────────────────────────────────────────
 * It has no id in any table and is recomputed on every read. `candidate_ids` is the only path
 * from a group to its members; there is no per-member summary on this response by design (the
 * API's own contract — a batch is counts, enums and ids, nothing more), so a console rendering
 * a batch links each id to its own decision screen rather than trying to summarise it here.
 *
 * ── SORTED `candidates` DESCENDING, TIE-BROKEN BY KEY — NOT `undecided` (contract correction
 * #2) ──────────────────────────────────────────────────────────────────────────────────────
 * This is the SERVER's real order, verified against `apps/api/src/admin/admin-skill-discovery.
 * service.ts`'s `groups()`. The issue's own prose argued for undecided-first; that argument is
 * not settled here, and this schema does not assume the server already sorts that way — see
 * `page.tsx`'s explicit, labelled, opt-in client-side re-sort.
 */
export const skillReviewGroupSchema = z.object({
  /** `<tier>|<family>|<anchor>` — derivable from the members, stable across identical requests. */
  key: z.string(),
  tier: tierSchema,
  trade_family: z.string().nullable(),
  /** The shared evidence token this batch is built on, or null for a family-only batch. */
  anchor: z.string().nullable(),
  /** A short header a reviewer can read. Display only; never parsed. */
  label: z.string(),
  /** Members, ascending by id. The ONLY path to a group's candidates on this response. */
  candidate_ids: z.array(z.string()),
  candidates: z.number(),
  /** `pending` + `needs_review` within the batch. `deferred` counts as decided — see the DTO. */
  undecided: z.number(),
  source_rows: z.number(),
  source_domains: z.number(),
  /** The pipeline's suggestion when every member agrees; null when they do not. `string`, not
   * the action union — mirrors `proposed_action`, which is CHECK-backed but not narrowed here. */
  unanimous_action: z.string().nullable(),
});
export type SkillReviewGroup = z.infer<typeof skillReviewGroupSchema>;

/**
 * The grouped view of one filtered population — mirrors `AdminSkillDiscoveryGroups`.
 *
 * `total_candidates`/`total_undecided` are summed FROM `groups` server-side, so the headline
 * cannot disagree with its own breakdown; this schema renders them verbatim, never recomputes.
 */
export const skillDiscoveryGroupsSchema = z.object({
  groups: z.array(skillReviewGroupSchema),
  total_groups: z.number(),
  total_candidates: z.number(),
  total_undecided: z.number(),
  /** Always the same literal string — `tier` is derived, not stored. */
  tier_basis: z.string(),
  /** Always the same literal string — a group is recomputed per read, stored nowhere. */
  grouping_basis: z.string(),
});
export type SkillDiscoveryGroups = z.infer<typeof skillDiscoveryGroupsSchema>;

/**
 * Requests the real, exhaustive batches for one filtered population.
 *
 * AN OVER-BROAD FILTER 400s NAMING THE COUNT rather than truncating — the caller (`page.tsx`)
 * must render that message verbatim (it tells the reviewer what to narrow), never treat it as a
 * generic failure. Reuses `skillDiscoveryQs`: the shared repeated-key/omit-empty rules are the
 * same for this route as for the queue, and `SkillDiscoveryGroupsFilters` is structurally a
 * subset of `SkillDiscoveryFilters` (fewer optional keys), so no second query builder is needed.
 */
export function listSkillDiscoveryGroups(
  f: SkillDiscoveryGroupsFilters = {},
): Promise<SkillDiscoveryGroups> {
  return adminFetch(`/admin/skill-discovery/groups${skillDiscoveryQs(f)}`, {
    schema: skillDiscoveryGroupsSchema,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skills?q= — the MAP/MERGE picker's lookup (#1280)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Mirrors `AdminCanonicalSkill`. `status`/`kind` are `string` — no DB CHECK on either column. */
export const canonicalSkillSchema = z.object({
  skill_id: z.string(),
  label_en: z.string(),
  status: z.string(),
  kind: z.string(),
  mappable: z.boolean(),
  not_mappable_reason: z.string().nullable(),
});

/**
 * Mirrors `AdminCanonicalSkillSearch`. `q` is ECHOED so a caller can discard a response that
 * arrived after a newer keystroke was already dispatched — see `CanonicalSkillOption`'s sibling
 * note in the pure vocabulary file, and `searchCanonicalSkillsAction`, which is the only caller.
 */
export const canonicalSkillSearchSchema = z.object({
  skills: z.array(canonicalSkillSchema),
  q: z.string(),
  truncated: z.boolean(),
});
export type CanonicalSkillSearch = z.infer<typeof canonicalSkillSearchSchema>;

/**
 * Search the canonical skills a MAP/MERGE decision could resolve onto.
 *
 * `q` MUST BE 2–80 CHARACTERS — `AdminSkillsQuerySchema`'s own bound — but this function does
 * not pre-validate it: a caller sending a stale one-character query earns the same honest 400
 * every other filter on this surface does, forwarded rather than silently withheld.
 */
export function searchCanonicalSkills(
  q: string,
  limit: number = ADMIN_SKILLS_PAGE_DEFAULT,
): Promise<CanonicalSkillSearch> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return adminFetch(`/admin/skills?${params.toString()}`, { schema: canonicalSkillSearchSchema });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/:id/audit — decision history (#1280)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One event-spine entry — mirrors `AdminSkillCandidateAuditEntry`. NO VALUES, by construction:
 * the spine's own payload is value-free, so an entry says WHO did WHAT and WHEN and nothing
 * else. `admin_id` is an OPAQUE id, never a name or email — this portal's identity egress stays
 * on the separate, reason-gated `reveal_pii` path and nothing here goes near it. */
export const skillCandidateAuditEntrySchema = z.object({
  event_id: z.string(),
  occurred_at: z.string(),
  /** `string`, not a closed union — the wire type itself types this `string`. */
  action_code: z.string(),
  admin_id: z.string().nullable(),
});
export type SkillCandidateAuditEntry = z.infer<typeof skillCandidateAuditEntrySchema>;

/**
 * The audit read — mirrors `AdminSkillCandidateAudit`.
 *
 * `current` IS NEVER NULL (contract correction #4). An undecided candidate has a `current`
 * whose FIELDS are null (`status: "pending"`, no reviewer, no reason), not an absent `current`
 * — a nullable block here would make "nothing has happened yet" indistinguishable from "the
 * candidate is gone", and the second of those is a 404 this route would never reach. This
 * schema therefore does NOT wrap `current` in `.nullable()`.
 *
 * BOTH HALVES ARE KEPT AS-IS. If `entries` (the immutable spine) and `current` (the row's own
 * state) ever disagree, that disagreement is the finding — this file does not reconcile them,
 * and neither does the page that renders it.
 */
export const skillCandidateAuditSchema = z.object({
  candidate_id: z.string(),
  /** Oldest first — an audit trail reads forwards. */
  entries: z.array(skillCandidateAuditEntrySchema),
  current: z.object({
    status: statusSchema,
    reviewer_admin_id: z.string().nullable(),
    reviewed_at: z.string().nullable(),
    review_reason: z.string().nullable(),
    resulting_skill_id: z.string().nullable(),
    approved_job_domain_ids: z.array(z.string()),
    approved_requirement: z.enum(ADMIN_SKILL_REQUIREMENTS),
  }),
  /** Always the same literal string — a decision is RECORDED here; the corpus is written by
   * the offline chain, so no entry in this list means a skill was created. */
  corpus_effect: z.string(),
});
export type SkillCandidateAudit = z.infer<typeof skillCandidateAuditSchema>;

export function getSkillDiscoveryAudit(id: string): Promise<SkillCandidateAudit> {
  return adminFetch(`/admin/skill-discovery/${encodeURIComponent(id)}/audit`, {
    schema: skillCandidateAuditSchema,
  });
}
