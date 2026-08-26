/**
 * EXISTING-TAXONOMY MATCHING and CANDIDATE CLUSTERING — the second free reduction.
 *
 * ===========================================================================
 * TWO QUESTIONS, ASKED IN THIS ORDER, BEFORE A MODEL IS PAID
 * ===========================================================================
 *   1. Does the shipped taxonomy ALREADY cover this phrase?      {@link matchExistingSkills}
 *   2. Do these candidates mean the same thing as EACH OTHER?    {@link clusterPhrases}
 *
 * Question 1 is the "prefer an existing skill over a new one" rule made executable. The
 * failure it prevents is the expensive one: minting `skill_cnc_setup` when
 * `skill_cnc_machine_setup` has been live for months means half the workers who have the
 * skill never match the postings that want it, and neither row is wrong enough for anyone to
 * notice. `validateTaxonomyCorpus` already refuses an id collision and an alias owned twice;
 * neither of those fires on two DIFFERENT ids holding one concept, which is why
 * `taxonomy-quality-gate.ts` exists and why this module reuses its evidence layer rather
 * than inventing a third notion of "same".
 *
 * Question 2 is the same test turned inward. A discovery run over 9,121 alias rows will
 * surface "CNC setup", "CNC machine setup" and "setting of CNC machine" from three different
 * domains, and they must arrive at review as ONE canonical proposal with two alias
 * candidates — not three competing skills that each pass every structural check.
 *
 * ===========================================================================
 * THE SIMILARITY SCORE IS LEXICAL AND THAT IS DELIBERATE
 * ===========================================================================
 * There is a vector index on `skill_alias.embedding` and it would give a better score. It is
 * not used here, for a reason that is about ORDER rather than quality: an embedding costs
 * money per phrase, and the entire purpose of this layer is to shrink the set BEFORE anything
 * is paid for. A free lexical pass that removes the phrases already sitting in `text_norm`
 * leaves a smaller set to embed, and the semantic pass then runs on that set, not on all
 * 9,121 rows. Vector rescoring belongs AFTER approval, in the existing
 * `db:embed:skills` + `db:eval:taxonomy` path — see `docs/architecture/skill-discovery-pipeline.md`.
 *
 * ONE EVIDENCE LAYER. `equivalenceEvidence` / `buildSkillSurface` come from
 * `taxonomy-lexical.ts`, which the reuse analyzer and the convergence detector already share.
 * A fourth copy of "are these the same concept" is the drift this repository has already been
 * bitten by twice.
 *
 * PURE. Rows are passed in as values; nothing here opens a connection.
 *
 * PRIVACY: reference vocabulary only — skill ids, labels, alias texts. The worker-language
 * source is pseudonymized upstream and stripped of forbidden characters by the classifier
 * before a phrase can reach this module.
 */
import { skeletonKey } from "@badabhai/profiling-lexicon";

import {
  buildSkillSurface,
  equivalenceEvidence,
  informativeTokens,
  jaccard,
  type EquivalenceRelation,
  type SkillSurface,
} from "./taxonomy-lexical";

// ===========================================================================
// The existing-skill index
// ===========================================================================

/** One shipped skill, as the index needs it. Built from `skill` + `skill_alias`. */
export interface ExistingSkillRow {
  readonly skillId: string;
  readonly labelEn: string;
  /** `skill.status`. Retrieval filters on `active`, so the index records it. */
  readonly status: string;
  /** `skill.kind` — `match_skill` rows are the closed `mskill_*` space. */
  readonly kind: string;
  readonly aliasTexts: readonly string[];
}

/**
 * The lookup structure. Built once per run, probed once per phrase.
 *
 * `bySurface` and `bySkeleton` are the two free rungs: an exact normalized hit is the L0
 * probe `skill_alias.text_norm` was added for, and a skeleton hit is L1 — the Hinglish
 * confusion fold that makes `velder`/`welder` one key. Both are exact-equality probes on a
 * Map, so the cost of asking is nil and the phrases they answer never reach the O(n·m)
 * evidence scan below them.
 */
export interface ExistingSkillIndex {
  readonly surfaces: readonly SkillSurface[];
  readonly rows: ReadonlyMap<string, ExistingSkillRow>;
  /** normalized surface form -> skill ids that answer to it. */
  readonly bySurface: ReadonlyMap<string, readonly string[]>;
  /** L1 consonant skeleton -> skill ids. */
  readonly bySkeleton: ReadonlyMap<string, readonly string[]>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  if (key.length === 0) return;
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else if (!existing.includes(value)) existing.push(value);
}

/**
 * Build the index of skills a discovered phrase may be matched against.
 *
 * `kind = 'match_skill'` ROWS ARE DROPPED, and this is the Phase-12 wall at its earliest
 * possible point. `mskill_*` is a closed, CEO-ratified 18-member vocabulary the deterministic
 * match engine consumes directly; a discovered phrase must never resolve onto it, and must
 * never even be OFFERED one as an option — a reviewer shown `"customs inspector" ->
 * mskill_quality_inspector (0.50)` would reasonably conclude that mapping was available.
 *
 * Dropping them HERE rather than filtering later is deliberate. The alternative — build the
 * index over everything and screen the results — leaves a correct-looking `matchExistingSkills`
 * that returns forbidden ids, and relies on every caller remembering to filter. The first full
 * dry run (2026-08-26) did exactly that and surfaced seven `mskill_*` matches before
 * `validateCandidate` was wired in. `skill_candidate_match_not_match_skill_chk` is the last
 * line of the same defence, in the database.
 */
export function buildExistingSkillIndex(rows: readonly ExistingSkillRow[]): ExistingSkillIndex {
  const surfaces: SkillSurface[] = [];
  const byId = new Map<string, ExistingSkillRow>();
  const bySurface = new Map<string, string[]>();
  const bySkeleton = new Map<string, string[]>();

  for (const row of rows) {
    if (row.kind === "match_skill" || row.skillId.startsWith("mskill_")) continue;
    const surface = buildSkillSurface(row.skillId, row.labelEn, row.aliasTexts);
    surfaces.push(surface);
    byId.set(row.skillId, row);
    for (const norm of surface.surface_norms) {
      push(bySurface, norm, row.skillId);
      push(bySkeleton, skeletonKey(norm), row.skillId);
    }
  }

  return { surfaces, rows: byId, bySurface, bySkeleton };
}

// ===========================================================================
// Matching one phrase
// ===========================================================================

/**
 * How a phrase relates to a shipped skill.
 *
 * `exact_surface` and `skeleton_surface` are this module's own; the rest are
 * {@link EquivalenceRelation} values passed through unchanged so a reviewer reads ONE
 * vocabulary across the reuse analyzer, the quality gate and this pipeline.
 */
export type MatchRelation = "exact_surface" | "skeleton_surface" | EquivalenceRelation;

export interface ExistingSkillMatch {
  readonly skillId: string;
  readonly relation: MatchRelation;
  /**
   * 0..1. Jaccard over informative tokens, with the two exact rungs pinned.
   *
   * PINNED, NOT COMPUTED, for the exact rungs: `"welding"` against a skill whose label is
   * `"Welding"` shares one token out of one and scores 1.0 anyway, but `"arc welding"`
   * matching an ALIAS `"arc welding"` of a skill LABELLED `"Gas Metal Arc Welding"` scores
   * 0.5 on labels while being a literal surface hit. The score must not contradict the
   * relation, because the review pack sorts on it.
   */
  readonly score: number;
  /** `strong` may be acted on; `weak` may only be escalated. Mirrors `EquivalenceEvidence`. */
  readonly strength: "strong" | "weak";
  readonly detail: string;
}

/** Score pinned for a literal normalized-surface hit. */
export const EXACT_SURFACE_SCORE = 1;
/** Score pinned for an L1 consonant-skeleton hit — one fold away from literal. */
export const SKELETON_SURFACE_SCORE = 0.95;

/**
 * The relations that may be reported as STRONG here, which is NARROWER than
 * `taxonomy-lexical.ts` grades them, deliberately.
 *
 * THE MEASURED REASON. That module compares two CURATED SKILL LABELS, where "CNC Turning"
 * being a strict token-subset of "CNC Turning and Facing" really is strong evidence of one
 * concept. This module compares an OCCUPATION TITLE against a skill label, and there the same
 * relation is routinely nonsense. From the first full dry run (2026-08-26), all reported
 * STRONG under the inherited grading:
 *
 *     "customs inspector"   ->  quality inspector   (subset: {inspector} within {customs, inspector})
 *     "bicycle mechanic"    ->  fitter              (subset)
 *     "battery servicing"   ->  plumber             (subset)
 *
 * Every one is an occupation sharing a generic role word with a skill label, and every one
 * would have driven a `map` suggestion. These are the same shape as the false matches already
 * on record in this repository (`ducting_installation -> plumber`,
 * `split_unit_installation -> fitter`), and the lesson is the same: a SPECIALIZATION relation
 * is not an IDENTITY relation.
 *
 * So subset and overlap are demoted to `weak` HERE. They still reach the reviewer, attached to
 * the candidate with their score and their evidence line; they simply cannot be the reason the
 * machine suggests a resolution (`WEAK_MATCH_DROVE_ACTION` in `validateCandidate`).
 */
export const STRONG_MATCH_RELATIONS: readonly MatchRelation[] = [
  "exact_surface",
  "skeleton_surface",
  "normalized_label_equal",
  "surface_form_shared",
  "informative_tokens_equal",
];

/** Is this relation strong enough to justify a machine SUGGESTION? See the constant above. */
export function isStrongRelation(relation: MatchRelation): boolean {
  return STRONG_MATCH_RELATIONS.includes(relation);
}

/**
 * Every shipped skill this phrase plausibly already is, best first.
 *
 * RETURNS A LIST, NOT A WINNER. Two shipped skills answering to one phrase is precisely the
 * `ALIAS_AMBIGUOUS` condition that makes canonicalization a coin flip, and collapsing it to a
 * single "best" match would hide the one finding a human must see. The caller decides;
 * {@link bestMatch} exists for the callers that only need the head of the list.
 */
export function matchExistingSkills(
  normalized: string,
  index: ExistingSkillIndex,
  limit = 5,
): ExistingSkillMatch[] {
  const out: ExistingSkillMatch[] = [];
  const claimed = new Set<string>();

  for (const skillId of index.bySurface.get(normalized) ?? []) {
    claimed.add(skillId);
    out.push({
      skillId,
      relation: "exact_surface",
      score: EXACT_SURFACE_SCORE,
      strength: "strong",
      detail: `${JSON.stringify(normalized)} is already a surface form of ${skillId} — the taxonomy covers this phrase`,
    });
  }

  for (const skillId of index.bySkeleton.get(skeletonKey(normalized)) ?? []) {
    if (claimed.has(skillId)) continue;
    claimed.add(skillId);
    out.push({
      skillId,
      relation: "skeleton_surface",
      score: SKELETON_SURFACE_SCORE,
      strength: "strong",
      detail: `${JSON.stringify(normalized)} folds to the same consonant skeleton as a surface form of ${skillId} — a spelling variant, not a new concept`,
    });
  }

  // The evidence scan, only for skills the two exact rungs did not already claim.
  const probe = buildSkillSurface("__probe__", normalized, []);
  const probeTokens = informativeTokens(normalized);
  for (const surface of index.surfaces) {
    if (claimed.has(surface.skill_id)) continue;
    const evidence = equivalenceEvidence(probe, surface);
    if (evidence === null) continue;
    out.push({
      skillId: surface.skill_id,
      relation: evidence.relation,
      score: jaccard(probeTokens, surface.label_tokens),
      // The evidence layer's own grading is NARROWED here, never widened — see
      // STRONG_MATCH_RELATIONS. A relation it already called weak stays weak.
      strength:
        evidence.strength === "strong" && isStrongRelation(evidence.relation) ? "strong" : "weak",
      detail: evidence.detail,
    });
  }

  out.sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId));
  return out.slice(0, limit);
}

/** The head of {@link matchExistingSkills}, or `null`. */
export function bestMatch(matches: readonly ExistingSkillMatch[]): ExistingSkillMatch | null {
  return matches[0] ?? null;
}

/** Is this phrase already IN the taxonomy — i.e. a literal or near-literal surface hit? */
export function isAlreadyCovered(match: ExistingSkillMatch | null): boolean {
  return match !== null && (match.relation === "exact_surface" || match.relation === "skeleton_surface");
}

/**
 * Is this phrase a plausible NEW ALIAS of a shipped skill rather than a new skill?
 *
 * A strong equivalence that is NOT already a surface form is exactly that: the concept exists,
 * the words do not. Attaching it is a one-row `skill_alias` insert, which is far cheaper and
 * far safer than minting a skill — and it is the outcome this pipeline should produce most
 * often if the shipped taxonomy is any good.
 */
export function isAliasOpportunity(match: ExistingSkillMatch | null): boolean {
  return match !== null && match.strength === "strong" && !isAlreadyCovered(match);
}

// ===========================================================================
// Clustering candidates against EACH OTHER
// ===========================================================================

/** One member of a cluster — a normalized phrase and how often the sources produced it. */
export interface ClusterMember {
  readonly normalized: string;
  readonly occurrences: number;
}

/**
 * A group of phrases that mean one thing.
 *
 * `canonical` is the member with the most occurrences, ties broken alphabetically — a total
 * order, so the same input always produces the same canonical and a re-run is diffable. It is
 * a PROPOSAL for the canonical label, never the label itself: the model proposes wording and
 * a human approves it, because "CNC setup" and "CNC machine setup" may both be worse than
 * "CNC machine setting" and no frequency count knows that.
 */
export interface PhraseCluster {
  /** Stable identity of the cluster: the canonical member's normalized form. */
  readonly key: string;
  readonly canonical: string;
  /** Every member including the canonical, most frequent first. */
  readonly members: readonly ClusterMember[];
  /** Members other than the canonical — the alias candidates this cluster proposes. */
  readonly aliasMembers: readonly string[];
  readonly occurrences: number;
  /** Why these were joined, one line per merge. Review evidence, never parsed. */
  readonly evidence: readonly string[];
}

/**
 * The ONLY relations that may merge two phrases into one candidate.
 *
 * TWO RUNGS WERE REMOVED AFTER MEASURING WHAT THEY DID.
 *
 * `strict_token_subset` — REMOVED. Under union-find, a subset relation becomes transitive in a
 * way the relation itself is not: "wood" merges with "wood metal", which merges with "metal",
 * which merges with "metal glass", and onward until one component swallows the corpus. The
 * first full dry run (2026-08-26) produced exactly that — a single "wood" cluster holding
 * 8,478 source rows, 5,706 distinct phrases and 2,814 of the 3,885 domains. The relation is
 * also SEMANTICALLY wrong for merging even without the chaining: "wood" and "wood carving" are
 * a material and a skill, not one concept.
 *
 * The L1 CONSONANT SKELETON — REMOVED. `skeletonKey` drops every interior vowel. It is built to
 * GENERATE candidates for a later rung to score, and its own docblock says so: "L1 GENERATES
 * candidates for L2/L3 to score rather than deciding anything". Used as a merge DECISION over
 * short keys it folds genuinely different words together — measured in the same run, `pile`,
 * `pool` and `ply` all reduce to `pl` and produced one cluster containing "pile-driver
 * operator", "swimming pool cleaner" and "ply bander"; `battery` and `butter` produced another
 * holding "battery assembler" beside "butter maker".
 *
 * What remains are IDENTITY relations: the same normalized string, a shared surface form, or
 * the same informative token set in a different order. Those three cannot chain into something
 * their members would not each individually justify.
 *
 * WEAK EVIDENCE NEVER MERGES either. `high_token_overlap` is a hint — "brake system servicing"
 * and "brake pad replacement" share `brake` and are different jobs. Everything excluded here is
 * reported by {@link weakCollisions} instead, so it reaches a human as a question rather than
 * as a decision already taken.
 */
export const MERGE_RELATIONS: readonly EquivalenceRelation[] = [
  "normalized_label_equal",
  "surface_form_shared",
  "informative_tokens_equal",
];

/** Union-find over phrases, joined ONLY by an identity relation ({@link MERGE_RELATIONS}). */
export function clusterPhrases(counts: ReadonlyMap<string, number>): PhraseCluster[] {
  const phrases = [...counts.keys()].sort();
  const parent = new Map<string, string>(phrases.map((p) => [p, p]));
  const evidence = new Map<string, string[]>();

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = x;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string, why: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(rb, ra);
    const list = evidence.get(ra) ?? [];
    list.push(why);
    evidence.set(ra, list);
    for (const line of evidence.get(rb) ?? []) list.push(line);
    evidence.delete(rb);
  };

  // IDENTITY RELATIONS ONLY. Quadratic, and bounded by the caller having already removed
  // everything the taxonomy covers and everything the classifier disposed of — this never runs
  // over the raw 9,121.
  const surfaces = phrases.map((p) => buildSkillSurface(p, p, []));
  for (let i = 0; i < surfaces.length; i += 1) {
    for (let j = i + 1; j < surfaces.length; j += 1) {
      const a = surfaces[i] as SkillSurface;
      const b = surfaces[j] as SkillSurface;
      if (find(a.skill_id) === find(b.skill_id)) continue;
      const ev = equivalenceEvidence(a, b);
      if (ev === null || !MERGE_RELATIONS.includes(ev.relation)) continue;
      union(a.skill_id, b.skill_id, ev.detail);
    }
  }

  const groups = new Map<string, string[]>();
  for (const phrase of phrases) {
    const root = find(phrase);
    const bucket = groups.get(root);
    if (bucket === undefined) groups.set(root, [phrase]);
    else bucket.push(phrase);
  }

  const clusters: PhraseCluster[] = [];
  for (const [root, members] of groups) {
    const withCounts: ClusterMember[] = members
      .map((normalized) => ({ normalized, occurrences: counts.get(normalized) ?? 0 }))
      .sort((a, b) => b.occurrences - a.occurrences || a.normalized.localeCompare(b.normalized));
    const canonical = (withCounts[0] as ClusterMember).normalized;
    clusters.push({
      key: canonical,
      canonical,
      members: withCounts,
      aliasMembers: withCounts.slice(1).map((m) => m.normalized),
      occurrences: withCounts.reduce((sum, m) => sum + m.occurrences, 0),
      evidence: evidence.get(root) ?? [],
    });
  }

  clusters.sort((a, b) => b.occurrences - a.occurrences || a.key.localeCompare(b.key));
  return clusters;
}

/** A pair the clusterer refused to merge but a reviewer should look at. */
export interface WeakCollision {
  readonly a: string;
  readonly b: string;
  readonly relation: EquivalenceRelation;
  readonly detail: string;
}

/**
 * Pairs joined only by WEAK evidence — reported, never merged.
 *
 * This is the honest half of clustering. Silently merging these would produce clusters whose
 * canonical label misdescribes half its members; silently dropping them would hide every
 * near-duplicate the strong rules cannot reach. Neither is acceptable, so they are escalated.
 */
export function weakCollisions(clusters: readonly PhraseCluster[], limit = 200): WeakCollision[] {
  const canonicals = clusters.map((c) => buildSkillSurface(c.canonical, c.canonical, []));
  const out: WeakCollision[] = [];
  for (let i = 0; i < canonicals.length && out.length < limit; i += 1) {
    for (let j = i + 1; j < canonicals.length && out.length < limit; j += 1) {
      const a = canonicals[i] as SkillSurface;
      const b = canonicals[j] as SkillSurface;
      const ev = equivalenceEvidence(a, b);
      // Everything the merge rung refused, not only what the evidence layer grades `weak`.
      // `strict_token_subset` is graded strong there and is excluded from merging here, so it
      // would otherwise vanish entirely — and "is this a specialization of that?" is exactly the
      // question a reviewer should be shown rather than have answered for them.
      if (ev === null || MERGE_RELATIONS.includes(ev.relation)) continue;
      out.push({ a: a.skill_id, b: b.skill_id, relation: ev.relation, detail: ev.detail });
    }
  }
  return out;
}
