import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  ADMIN_SKILL_REQUIREMENTS,
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
const requirementSchema = z.enum(ADMIN_SKILL_REQUIREMENTS);

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
   * THE REVIEWER'S OWN TRADE JUDGEMENT, once a `create` decision has recorded one — empty on
   * every undecided row and on every non-create decision.
   *
   * It is served because it is the half of an approval that nothing else can reconstruct. The
   * corpus gate refuses a skill with no trade link, the pipeline may not infer which trades a
   * skill belongs to, so a human names them — and if the screen does not show what they named,
   * the decision is only half auditable. Outside the provenance digest by design: it is a new
   * fact recorded at review time, not something the run observed.
   */
  approved_job_domain_ids: z.array(z.string()),
  /** `required` or `preferred` for those trades. Defaults to the conservative one server-side. */
  approved_requirement: requirementSchema,
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

const countBucket = <T extends z.ZodTypeAny>(key: T) => z.object({ key, count: z.number() });

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
// GET /admin/skill-discovery/groups — the review BATCHES, grouped by the server
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE REVIEW BATCH, exactly as the server computed it.
 *
 * ── THE CONSOLE DOES NOT GROUP ANYTHING ────────────────────────────────────────────────
 * This screen used to bucket ONE PAGE of the queue by `trade_family` in the browser, because no
 * grouping route existed. It does not any more, and the browser-side version is deleted rather
 * than kept as a fallback. Two reasons, and the second is the one that matters:
 *
 *   1. It could only ever group a PAGE. A group's whole contract is that its member list is
 *      complete for the filters — a reviewer opening a batch of twelve must find twelve rows —
 *      and a keyset page cannot promise that.
 *   2. `anchor` is chosen from a token count taken across the WHOLE filtered set. A browser
 *      holding fifty rows cannot compute a weight defined over six thousand, so a page-local
 *      version would hand the same candidate a different batch on every page-turn: a second
 *      grouping algorithm silently disagreeing with the real one.
 *
 * So `key`, `anchor`, `label`, the membership and the ordering are all read from the response and
 * none of them is recomputed here. Groups arrive biggest-first; that order is rendered as given.
 *
 * ── AND A GROUP IS STILL A LENS, NOT A TAXONOMY OBJECT ─────────────────────────────────
 * `grouping_basis` says so in band. There is no group id in any table, no group-level decision,
 * and every member keeps its own decision, its own reason and its own audit row.
 */
export const skillReviewGroupSchema = z.object({
  /** `<tier>|<family>|<anchor>` — derivable from the members, stable across identical requests. */
  key: z.string(),
  tier: tierSchema,
  trade_family: z.string().nullable(),
  /** The shared evidence term this batch is built on, or null for a family-only batch. */
  anchor: z.string().nullable(),
  /** A short header a reviewer reads. Display only — never parsed, never split back apart. */
  label: z.string(),
  candidate_ids: z.array(z.string()),
  candidates: z.number(),
  /** `pending` + `needs_review`. `deferred` counts as decided — somebody looked. */
  undecided: z.number(),
  /** Attestation weight: a count of source rows, never a measurement of similarity. */
  source_rows: z.number(),
  /** DISTINCT trades behind the batch — a union across members, not a sum of per-row counts. */
  source_domains: z.number(),
  /** The pipeline's suggestion when every member agrees; null when they do not. */
  unanimous_action: z.string().nullable(),
});
export type SkillReviewGroup = z.infer<typeof skillReviewGroupSchema>;

export const skillDiscoveryGroupsSchema = z.object({
  groups: z.array(skillReviewGroupSchema),
  /** How many review screens the filtered population reduces to. */
  total_groups: z.number(),
  /** Summed from `groups` server-side, so the headline cannot disagree with its breakdown. */
  total_candidates: z.number(),
  total_undecided: z.number(),
  tier_basis: z.string(),
  /** The in-band marker: a group is recomputed per read and has no row anywhere. */
  grouping_basis: z.string(),
});
export type SkillDiscoveryGroups = z.infer<typeof skillDiscoveryGroupsSchema>;

/**
 * The grouping query — the queue's filters MINUS the three that make no sense over a whole set.
 *
 * No `cursor`, no `limit`, no `sort`: the route groups the filtered population or refuses with a
 * 400 naming the count. That refusal is a feature and this console renders it as one, because a
 * truncated grouping would still claim to be exhaustive — which is the failure the cap exists to
 * prevent.
 */
export type SkillDiscoveryGroupFilters = Omit<SkillDiscoveryFilters, "cursor" | "limit" | "sort">;

export function listSkillDiscoveryGroups(
  f: SkillDiscoveryGroupFilters = {},
): Promise<SkillDiscoveryGroups> {
  return adminFetch(`/admin/skill-discovery/groups${skillDiscoveryQs(f)}`, {
    schema: skillDiscoveryGroupsSchema,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skills?q= — the MAP/MERGE picker's lookup
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE CANONICAL SKILL, as the picker needs it.
 *
 * ── `mappable` IS WHY THIS SHAPE EXISTS ────────────────────────────────────────────────
 * The route returns skills that MATCH and says which of them may actually be mapped onto, rather
 * than filtering the rest out silently. A reviewer searching for a skill they remember and
 * getting nothing back cannot tell "no such skill" from "deprecated" from "that is match
 * vocabulary" — and those need three different actions. So the ineligible ones are rendered,
 * unselectable, with the server's own reason beside them.
 *
 * The eligibility rule is the same one the decision route enforces on the write, so the picker
 * cannot offer a target the write would then refuse.
 */
export const adminCanonicalSkillSchema = z.object({
  /** `skill_<slug>` — a text primary key, never a uuid. */
  skill_id: z.string(),
  label_en: z.string(),
  status: z.string(),
  kind: z.string(),
  mappable: z.boolean(),
  not_mappable_reason: z.string().nullable(),
});
export type AdminCanonicalSkill = z.infer<typeof adminCanonicalSkillSchema>;

export const adminCanonicalSkillSearchSchema = z.object({
  skills: z.array(adminCanonicalSkillSchema),
  /** Echoed, so a stale response cannot be read as the answer to a newer keystroke. */
  q: z.string(),
  /** True when the result was cut at the limit — the console asks for a longer term. */
  truncated: z.boolean(),
});
export type AdminCanonicalSkillSearch = z.infer<typeof adminCanonicalSkillSearchSchema>;

/**
 * Search the canonical corpus for a MAP/MERGE target.
 *
 * THIS IS THE ADMIN-AUTHED ROUTE, NOT THE INTERNAL SKILLS SEAM. The service-to-service skills
 * controller sits behind its own credential: a browser session reaching for it would pass the
 * wrong guard, carry no admin identity, and leave no trace under the operator's session. It is
 * never called from this app, and this function is the reason nobody needs to.
 *
 * Server-only, like every other call in this module. The search runs inside a Server Action, so
 * no admin route is ever fetched from the browser.
 */
export function searchCanonicalSkills(
  q: string,
  limit?: number,
): Promise<AdminCanonicalSkillSearch> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set("limit", String(limit));
  return adminFetch(`/admin/skills?${params.toString()}`, {
    schema: adminCanonicalSkillSearchSchema,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/:id/audit — what has happened to this candidate
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE AUDIT ENTRY, from the EVENT SPINE.
 *
 * The spine is the immutable half: a decision writes one value-free governed event on the same
 * transaction as the row, so an entry cannot have been edited afterwards. It says WHO did WHAT
 * and WHEN and carries no values, because the event payload carries none by construction — the
 * reviewer's reason lives on the row, served once, rather than being copied here where the two
 * could disagree.
 */
export const skillCandidateAuditEntrySchema = z.object({
  /** The spine row's own id — what an auditor cites. */
  event_id: z.string(),
  occurred_at: z.string(),
  /** One of the five `skill_candidate_*` codes, each named for the status it records. */
  action_code: z.string(),
  /** An opaque admin id. Never a name, never an email. */
  admin_id: z.string().nullable(),
});
export type SkillCandidateAuditEntry = z.infer<typeof skillCandidateAuditEntrySchema>;

/**
 * THE AUDIT READ — the spine entries PLUS the decision as the row holds it now.
 *
 * Both halves, because either alone misleads: the spine says what happened, the row says what the
 * candidate currently is, and an auditor needs to see them agree. If they ever do not, that
 * disagreement is the finding — which a response carrying only one half could never surface.
 *
 * `current` is ALWAYS present. An undecided candidate has a `current` whose fields are null, not
 * an absent block: a nullable one would make "nothing has happened yet" and "the row is gone" the
 * same response, and the second is a 404.
 */
export const skillCandidateAuditSchema = z.object({
  candidate_id: z.string(),
  /** Oldest first — an audit trail reads forwards. Rendered in the order given. */
  entries: z.array(skillCandidateAuditEntrySchema),
  current: z.object({
    status: statusSchema,
    reviewer_admin_id: z.string().nullable(),
    reviewed_at: z.string().nullable(),
    review_reason: z.string().nullable(),
    resulting_skill_id: z.string().nullable(),
    approved_job_domain_ids: z.array(z.string()),
    approved_requirement: requirementSchema,
  }),
  /** Always the literal: a decision is RECORDED, and no entry here means a skill was created. */
  corpus_effect: z.string(),
});
export type SkillCandidateAudit = z.infer<typeof skillCandidateAuditSchema>;

export function getSkillCandidateAudit(id: string): Promise<SkillCandidateAudit> {
  return adminFetch(`/admin/skill-discovery/${encodeURIComponent(id)}/audit`, {
    schema: skillCandidateAuditSchema,
  });
}
