/**
 * Offline Path-A retrieval replay — the pure core.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * D0 chose Path A (`job_domain_skill`) as the target production retrieval contract, and the
 * staged plan needs a SHADOW before Stage B. A live shadow is unavailable: production
 * canonicalization is off, and enabling it merely to observe would be exactly the change the
 * shadow exists to de-risk. So the shadow is offline — the same phrases, replayed against the
 * authoritative corpus, with both candidate paths computed in memory.
 *
 * It also answers a question the fixture cannot answer directly. TD-01 minted
 * `skill_drawing_reading` as ACTIVE with ZERO `job_domain_skill` edges while its two
 * predecessors kept their 8 + 6 edges and went `deprecated` (risk R19). No fixture case names
 * any of those three skills, so RECALL is blind to it. What is not blind is the CANDIDATE SET:
 * this module measures which aliases each path can even see, which is where the defect lives.
 *
 * ===========================================================================
 * WHY THREE CORPUS VARIANTS, AND WHY THEY ARE ALL DERIVED FROM ONE SOURCE
 * ===========================================================================
 * SG-5 is what makes this possible. TD-01/02/03 deprecated their source skills but left every
 * row, id and alias array intact, so the CURRENT corpus still contains everything needed to
 * reconstruct the pre-merge state exactly — no git archaeology, no second source to drift.
 *
 *   PRE_MERGE        predecessors active, `skill_drawing_reading` absent. What retrieval saw
 *                    before TD-01/02/03. The baseline.
 *   AS_APPLIED       `main` exactly. Predecessors deprecated, successor active with 0 edges.
 *   EDGES_REPOINTED  AS_APPLIED plus TD-01's 14 edges moved onto the successor. A pure
 *                    COUNTERFACTUAL — it mutates nothing, it exists so the cost of the
 *                    unauthorized edge re-point can be quantified before anyone decides it.
 *
 * PRE_MERGE→AS_APPLIED is the TD-01 impact. AS_APPLIED→EDGES_REPOINTED is what the re-point
 * would buy. Both are needed: a defect nobody has costed is a defect nobody can rank.
 *
 * ===========================================================================
 * THE TWO PATHS ARE MIRRORED FROM `skills.repository.ts`, NOT RE-DERIVED
 * ===========================================================================
 * Path A  = `canonicalAliasRows`: JOIN job_domain_skill (active) + skill (active) + embedded.
 * Path B  = `legacyAliasRows`:    sa.domain_id = <slug> + skill (active) + embedded.
 *
 * Both carry `s.status = 'active'`. That is easy to miss on Path B — it has no edge join, so it
 * LOOKS untouched by a deprecation — and getting it wrong would understate the blast radius of
 * every TD. `path-a-replay.test.ts` pins both predicate sets against the repository source, so
 * a production change breaks this file rather than silently drifting away from it.
 *
 * No IO here: no database, no provider, no filesystem. Vectors arrive as arguments. That is
 * what makes the replay reproducible and the invariants testable.
 */
import type { SkillStatus } from "@badabhai/taxonomy";
import { evaluateCase } from "./taxonomy-retrieval-metrics";
// IMPORTED, not re-declared. A second copy of this set is exactly how the replay came to
// disagree with the two harnesses that already honoured it — see `coverageOnly` below.
import { COVERAGE_ONLY_CATEGORIES } from "./taxonomy-retrieval-eval";

/**
 * Statuses production retrieval will serve. Mirrors both repository statements.
 *
 * A PARAMETER, defaulting to production's literal, for the reason `taxonomy-retrieval-eval.ts`
 * already documents: all 98 growth-corpus skills are `provisional`, so an active-only run
 * reports R@1 = 0 — true about production, useless about the corpus. Widening it is explicit
 * and is stamped into the report, so a reader can always tell which question a number answers.
 */
export const RETRIEVABLE_SKILL_STATUSES: readonly SkillStatus[] = ["active"];
export const PRE_PROMOTION_STATUSES: readonly SkillStatus[] = ["active", "provisional"];

/** The legacy scope every live caller hard-codes (`LEGACY_ANCHOR_SKILL_DOMAIN`). */
export const LEGACY_ANCHOR_SKILL_DOMAIN = "cnc-machining";

export type RetrievalPath = "path_a_canonical" | "path_b_legacy";

export type CorpusVariant = "pre_merge" | "as_applied" | "edges_repointed";

/** One alias as retrieval sees it: a text, its owning skill, and that skill's reachability. */
export interface ReplayAlias {
  readonly skillId: string;
  readonly text: string;
  readonly lang: string;
  /** Denormalized from the skill by `seed-skills.ts` — Path B's only filter. */
  readonly domainId: string;
  /** Absent when the corpus declares an alias no embedding exists for. */
  readonly vector: readonly number[] | null;
}

export interface ReplaySkill {
  readonly skillId: string;
  readonly status: SkillStatus;
  readonly replacedBy: string | null;
  /**
   * The status this skill carried BEFORE a merge annotated it — supplied by the caller, which
   * is the only layer that knows where the row came from.
   *
   * Restoring every deprecated skill to `active` would be wrong and would flatter the
   * baseline. TD-01/02/03 dissolved *active, shipped* `SKILL_CORPUS` skills, so those restore
   * to `active`. TD-04/TD-06 dissolved **provisional, never-promoted** growth-corpus skills,
   * which were already excluded from retrieval by `PRODUCTION_SKILL_STATUSES`; restoring them
   * to `active` would invent reachability that never existed and credit the merges with a loss
   * they did not cause.
   */
  readonly preMergeStatus: SkillStatus;
}

/** An active `job_domain_skill` edge. */
export interface ReplayEdge {
  readonly jobDomainId: string;
  readonly skillId: string;
}

export interface ReplayCorpus {
  readonly variant: CorpusVariant;
  readonly skills: readonly ReplaySkill[];
  readonly aliases: readonly ReplayAlias[];
  readonly edges: readonly ReplayEdge[];
}

// ===========================================================================
// Building the three variants from one authoritative source
// ===========================================================================

/**
 * Where an alias belonged BEFORE a merge minted its current owner.
 *
 * Needed for exactly one case and declared rather than guessed. Most of a minted skill's
 * aliases are copies of texts its predecessors still hold (SG-5 keeps their arrays intact), so
 * dropping the copy reconstructs the pre-merge surface perfectly. `drawing padhna` is the
 * exception: it is a TAX-5 wedge alias that MOVED, so the predecessors hold no copy of it and
 * dropping it would understate the pre-merge baseline by one alias across 6 job domains.
 *
 * The owner below is not inferred — `wedge-aliases.ts` records the chain in its own note:
 * ratified Q-B onto `skill_cad_interpretation` (2026-07-16), repointed to
 * `skill_drawing_reading` for TD-01 (2026-08-18). "Heaviest predecessor" would have picked
 * `skill_gdt_reading` and been wrong, which is why this is a declared input and not a rule.
 *
 * `buildVariant` FAILS on any orphan alias missing from this map. A future merge that moves a
 * unique alias must extend it consciously rather than silently skewing a baseline.
 */
export const PRE_MERGE_ALIAS_OWNER: Readonly<Record<string, string>> = {
  "drawing padhna": "skill_cad_interpretation",
};

export interface CorpusInput {
  readonly skills: readonly ReplaySkill[];
  readonly aliases: readonly ReplayAlias[];
  readonly edges: readonly ReplayEdge[];
}

/** What `buildVariant` decided, so a reader can audit the reconstruction. */
export interface VariantProvenance {
  /** Merge targets that exist only because of a merge — removed in `pre_merge`. */
  readonly mintedSkillIds: readonly string[];
  /** Deprecated skills restored to `active` in `pre_merge`. */
  readonly restoredSkillIds: readonly string[];
  /** Aliases on a minted skill with no predecessor copy, and where they were sent. */
  readonly reassignedAliases: readonly { text: string; to: string }[];
  /** Edges moved onto a minted skill in `edges_repointed`. */
  readonly repointedEdges: readonly ReplayEdge[];
}

/**
 * A skill that exists ONLY because a merge created it: something points at it via
 * `replacedBy`, and it carries no `job_domain_skill` edge of its own.
 *
 * Derived rather than hardcoded, so the reconstruction describes the corpus instead of one
 * remembered decision — `skill_quality_control` and `skill_turning` are also `replacedBy`
 * targets, and both survive `pre_merge` correctly because both hold edges.
 *
 * The zero-edge test doing double duty here is not a coincidence: a merge target that already
 * had edges pre-existed the merge, and one that has none was minted by it. That is also
 * precisely the R19 defect, which is why the same predicate names both.
 */
export function findMintedSkillIds(input: CorpusInput): readonly string[] {
  const edged = new Set(input.edges.map((e) => e.skillId));
  const targets = new Set(
    input.skills.filter((s) => s.replacedBy !== null).map((s) => s.replacedBy!),
  );
  return [...targets].filter((id) => !edged.has(id)).sort();
}

/** A merge as the corpus records it: one successor and everything dissolved into it. */
export interface MergeFamily {
  readonly successor: string;
  readonly predecessors: readonly string[];
  /** False = the R19 shape: the successor exists but retrieval cannot reach it. */
  readonly successorHasEdges: boolean;
}

/**
 * Every merge in the corpus, derived from `replacedBy` ALONE.
 *
 * Deliberately NOT gated on the successor being edgeless, unlike `findMintedSkillIds`. That
 * distinction is the whole point: `findMintedSkillIds` answers "which successor was minted by
 * a merge and is therefore absent from the pre-merge baseline", which is a question about
 * reconstruction. This answers "which skills belong to the same merge", which is a question
 * about identity — and identity must not change when the edges are repaired.
 *
 * Using the edgeless test here would make the diagnostic probe switch itself off the moment
 * R19 is fixed, so the run that proves the fix worked would report nothing at all. A probe that
 * vanishes on success cannot distinguish success from never having run.
 */
export function mergeFamilies(input: CorpusInput): readonly MergeFamily[] {
  const edged = new Set(input.edges.map((e) => e.skillId));
  const bySuccessor = new Map<string, string[]>();
  for (const s of input.skills) {
    if (s.replacedBy === null) continue;
    bySuccessor.set(s.replacedBy, [...(bySuccessor.get(s.replacedBy) ?? []), s.skillId]);
  }
  return [...bySuccessor.entries()]
    .map(([successor, predecessors]) => ({
      successor,
      predecessors: [...predecessors].sort(),
      successorHasEdges: edged.has(successor),
    }))
    .sort((a, b) => a.successor.localeCompare(b.successor));
}

export function buildVariant(
  input: CorpusInput,
  variant: CorpusVariant,
): { corpus: ReplayCorpus; provenance: VariantProvenance } {
  const minted = findMintedSkillIds(input);
  const mintedSet = new Set(minted);

  if (variant === "as_applied") {
    return {
      corpus: { variant, skills: input.skills, aliases: input.aliases, edges: input.edges },
      provenance: {
        mintedSkillIds: minted,
        restoredSkillIds: [],
        reassignedAliases: [],
        repointedEdges: [],
      },
    };
  }

  if (variant === "edges_repointed") {
    // Move every edge held by a deprecated skill onto its successor — the counterfactual the
    // unauthorized re-point would produce. Only edges whose successor was MINTED move: a
    // successor that already has its own edges never lost anything to begin with.
    const successor = new Map(
      input.skills
        .filter((s) => s.replacedBy !== null && mintedSet.has(s.replacedBy!))
        .map((s) => [s.skillId, s.replacedBy!]),
    );
    const repointed: ReplayEdge[] = [];
    const edges = input.edges.map((e) => {
      const to = successor.get(e.skillId);
      if (to === undefined) return e;
      const moved = { jobDomainId: e.jobDomainId, skillId: to };
      repointed.push(moved);
      return moved;
    });
    return {
      corpus: { variant, skills: input.skills, aliases: input.aliases, edges },
      provenance: {
        mintedSkillIds: minted,
        restoredSkillIds: [],
        reassignedAliases: [],
        repointedEdges: repointed,
      },
    };
  }

  // pre_merge — undo the deprecations, delete the minted skills, restore moved aliases.
  // Each skill returns to ITS OWN `preMergeStatus`, not a blanket `active`.
  const restored = input.skills
    .filter((s) => s.status === "deprecated" && s.replacedBy !== null)
    .map((s) => `${s.skillId}->${s.preMergeStatus}`);
  const restoredSet = new Set(
    input.skills
      .filter((s) => s.status === "deprecated" && s.replacedBy !== null)
      .map((s) => s.skillId),
  );
  const skills = input.skills
    .filter((s) => !mintedSet.has(s.skillId))
    .map((s) =>
      restoredSet.has(s.skillId) ? { ...s, status: s.preMergeStatus, replacedBy: null } : s,
    );

  const predecessorTexts = new Set(
    input.aliases.filter((a) => restoredSet.has(a.skillId)).map((a) => a.text),
  );
  const domainOf = new Map(input.aliases.map((a) => [a.skillId, a.domainId]));
  const reassigned: { text: string; to: string }[] = [];
  const aliases: ReplayAlias[] = [];
  for (const a of input.aliases) {
    if (!mintedSet.has(a.skillId)) {
      aliases.push(a);
      continue;
    }
    // A minted skill's alias. If a predecessor still holds the same text, its copy already
    // represents this alias pre-merge and this one is dropped.
    if (predecessorTexts.has(a.text)) continue;
    const owner = PRE_MERGE_ALIAS_OWNER[a.text];
    if (owner === undefined) {
      throw new Error(
        `[path-a-replay] cannot reconstruct pre_merge: alias ${JSON.stringify(a.text)} on minted ` +
          `skill ${a.skillId} has no predecessor copy and no PRE_MERGE_ALIAS_OWNER entry. ` +
          `Add one citing the ratification record rather than letting the baseline drift.`,
      );
    }
    reassigned.push({ text: a.text, to: owner });
    aliases.push({ ...a, skillId: owner, domainId: domainOf.get(owner) ?? a.domainId });
  }

  return {
    corpus: {
      variant,
      skills,
      aliases,
      edges: input.edges.filter((e) => !mintedSet.has(e.skillId)),
    },
    provenance: {
      mintedSkillIds: minted,
      restoredSkillIds: restored.sort(),
      reassignedAliases: reassigned,
      repointedEdges: [],
    },
  };
}

// ===========================================================================
// Candidate sets — the half of retrieval that the corpus decides
// ===========================================================================

/**
 * Candidates Path A can see for a job domain.
 *
 * Two independent gates, and TD-01 fails a case on each side at once: the predecessors hold
 * the edges but are `deprecated` (gate 2), the successor is `active` but holds no edge
 * (gate 1). Either alone would be survivable; together they erase the surface.
 */
export function pathACandidates(
  corpus: ReplayCorpus,
  jobDomainId: string,
  statuses: readonly SkillStatus[] = RETRIEVABLE_SKILL_STATUSES,
): readonly ReplayAlias[] {
  const status = new Map(corpus.skills.map((s) => [s.skillId, s.status]));
  const edged = new Set(
    corpus.edges.filter((e) => e.jobDomainId === jobDomainId).map((e) => e.skillId),
  );
  return corpus.aliases.filter(
    (a) =>
      edged.has(a.skillId) &&
      statuses.includes(status.get(a.skillId) as SkillStatus) &&
      a.vector !== null,
  );
}

/** Candidates Path B can see for a legacy domain slug. No edge join; same status filter. */
export function pathBCandidates(
  corpus: ReplayCorpus,
  domainId: string,
  statuses: readonly SkillStatus[] = RETRIEVABLE_SKILL_STATUSES,
): readonly ReplayAlias[] {
  const status = new Map(corpus.skills.map((s) => [s.skillId, s.status]));
  return corpus.aliases.filter(
    (a) =>
      a.domainId === domainId &&
      statuses.includes(status.get(a.skillId) as SkillStatus) &&
      a.vector !== null,
  );
}

// ===========================================================================
// Ranking
// ===========================================================================

/** Cosine similarity. Mirrors `1 - (embedding <=> $1)` for normalized pgvector cosine. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export interface ScoredAlias {
  readonly skillId: string;
  readonly text: string;
  readonly score: number;
}

/**
 * Score and order candidates, then take k — the `ORDER BY <=> LIMIT k` shape.
 *
 * Ties break on (text, skillId) so a run is byte-reproducible. Postgres would not promise
 * that, but a replay whose output changes between identical runs is not evidence, and the
 * determinism is asserted by test rather than hoped for.
 */
export function rankAliases(
  query: readonly number[],
  candidates: readonly ReplayAlias[],
  k: number,
): readonly ScoredAlias[] {
  return candidates
    .map((c) => ({ skillId: c.skillId, text: c.text, score: cosine(query, c.vector!) }))
    .sort(
      (x, y) =>
        y.score - x.score || x.text.localeCompare(y.text) || x.skillId.localeCompare(y.skillId),
    )
    .slice(0, k);
}

/** Best-scoring alias per skill, ordered — what the caller actually consumes. */
export function rankSkillsFromAliases(rows: readonly ScoredAlias[]): readonly ScoredAlias[] {
  const best = new Map<string, ScoredAlias>();
  for (const r of rows) {
    const prev = best.get(r.skillId);
    if (prev === undefined || r.score > prev.score) best.set(r.skillId, r);
  }
  return [...best.values()].sort(
    (x, y) => y.score - x.score || x.skillId.localeCompare(y.skillId),
  );
}

// ===========================================================================
// Per-case outcome
// ===========================================================================

export interface ReplayCaseResult {
  readonly caseId: string;
  readonly path: RetrievalPath;
  readonly variant: CorpusVariant;
  readonly candidateCount: number;
  /** `true` when the path returned nothing — the empty-rate D0 Phase D asks for. */
  readonly unresolved: boolean;
  readonly top1SkillId: string | null;
  readonly top1Score: number | null;
  /** null on a NEGATIVE case — one whose correct outcome is "nothing relevant". */
  readonly expectedSkillId: string | null;
  readonly negative: boolean;
  /**
   * A COVERAGE-ONLY case: it has an expected skill, but that skill is shipped-and-reused-only,
   * so the case asks "is this reachable at all" rather than "is it ranked first". Excluded from
   * Recall/MRR and reported separately — `taxonomy-retrieval-eval.ts` and
   * `taxonomy-alias-experiment.ts` have always done this, and the fixture's own notes say so
   * per-case ("excluded from headline Recall/MRR — reported as its own category").
   */
  readonly coverageOnly: boolean;
  readonly hit: boolean;
  /** 1-based rank of the expected (or acceptable) skill; null when it never appeared. */
  readonly expectedRank: number | null;
  /** Forbidden ids that came back — a scoping regression on a negative case. */
  readonly structuralViolations: readonly string[];
  /** Forbidden ids that beat the expected skill on a positive case. */
  readonly outranked: readonly string[];
  readonly skills: readonly ScoredAlias[];
}

/**
 * Replay one case.
 *
 * Correctness is delegated to `evaluateCase` — the pinned evaluator (v2) the whole taxonomy
 * programme already scores with. Re-deriving "did it hit" here would quietly diverge on the
 * three things it gets right and a naive comparison gets wrong: reviewed ALTERNATIVES are also
 * correct, a NEGATIVE case is one whose right answer is "nothing relevant", and a forbidden id
 * that outranks the expected skill is a failure even when the expected skill did appear.
 */
export function replayCase(
  corpus: ReplayCorpus,
  path: RetrievalPath,
  args: {
    caseId: string;
    query: readonly number[];
    jobDomainId: string;
    legacyDomainId: string;
    expectedSkillId: string | null;
    acceptableSkillIds?: readonly string[];
    forbiddenSkillIds?: readonly string[];
    k: number;
    statuses?: readonly SkillStatus[];
    /**
     * The fixture case's `category`. Optional so existing callers compile, but a caller that
     * omits it gets the case counted in Recall — which for an `unembedded_shipped` case is the
     * wrong answer. `replay-path-a.ts` passes it.
     */
    category?: string;
  },
): ReplayCaseResult {
  const candidates =
    path === "path_a_canonical"
      ? pathACandidates(corpus, args.jobDomainId, args.statuses)
      : pathBCandidates(corpus, args.legacyDomainId, args.statuses);
  const skills = rankSkillsFromAliases(rankAliases(args.query, candidates, args.k));

  const outcome = evaluateCase(
    {
      expected_skill_id: args.expectedSkillId,
      acceptable_skill_ids: args.acceptableSkillIds,
      must_not_return_skill_ids: args.forbiddenSkillIds,
    },
    skills.map((s) => ({ skill_id: s.skillId, score: s.score })),
    args.k,
  );

  const negative = args.expectedSkillId === null && (args.acceptableSkillIds ?? []).length === 0;
  // A negative case is never coverage-only: it has no expected skill to cover, and its whole
  // purpose is the false-positive check, which stays in force.
  const coverageOnly = !negative && args.category !== undefined && COVERAGE_ONLY_CATEGORIES.has(args.category);
  return {
    caseId: args.caseId,
    path,
    variant: corpus.variant,
    candidateCount: candidates.length,
    unresolved: skills.length === 0,
    top1SkillId: skills[0]?.skillId ?? null,
    top1Score: skills[0]?.score ?? null,
    expectedSkillId: args.expectedSkillId,
    negative,
    coverageOnly,
    // A negative case is "hit" when it stayed clean; a positive one when it ranked first.
    // `hit` is still computed for a coverage-only case — it is what the coverage line reports —
    // it simply does not enter Recall/MRR.
    hit: negative ? outcome.structuralViolations.length === 0 : outcome.rank === 1,
    expectedRank: outcome.rank,
    structuralViolations: outcome.structuralViolations,
    outranked: outcome.outranked,
    skills,
  };
}

// ===========================================================================
// Diffing two runs
// ===========================================================================

export type CaseDelta =
  | "unchanged"
  | "fixed" // wrong or unresolved before, correct after
  | "broken" // correct before, wrong or unresolved after
  | "became_unresolved"
  | "became_resolved"
  | "top1_changed" // both wrong, but a different wrong answer
  | "candidates_changed"; // same answer, different candidate set

export interface CaseDiff {
  readonly caseId: string;
  readonly delta: CaseDelta;
  readonly before: ReplayCaseResult;
  readonly after: ReplayCaseResult;
  readonly candidateDelta: number;
  readonly scoreDelta: number | null;
}

/**
 * Classify one case across two runs.
 *
 * Order matters: correctness changes outrank resolution changes, which outrank a different
 * wrong answer, which outranks a candidate-set change that moved nothing. Reporting
 * `candidates_changed` for a case that actually broke would bury the finding under noise.
 */
export function diffCase(before: ReplayCaseResult, after: ReplayCaseResult): CaseDiff {
  const candidateDelta = after.candidateCount - before.candidateCount;
  const scoreDelta =
    before.top1Score === null || after.top1Score === null
      ? null
      : after.top1Score - before.top1Score;
  const base = { caseId: before.caseId, before, after, candidateDelta, scoreDelta };

  if (before.hit && !after.hit) return { ...base, delta: "broken" };
  if (!before.hit && after.hit) return { ...base, delta: "fixed" };
  if (!before.unresolved && after.unresolved) return { ...base, delta: "became_unresolved" };
  if (before.unresolved && !after.unresolved) return { ...base, delta: "became_resolved" };
  if (before.top1SkillId !== after.top1SkillId) return { ...base, delta: "top1_changed" };
  if (candidateDelta !== 0) return { ...base, delta: "candidates_changed" };
  return { ...base, delta: "unchanged" };
}

export interface ReplaySummary {
  readonly cases: number;
  readonly resolved: number;
  readonly unresolved: number;
  /** POSITIVE cases only — the ones with a correct answer to find. */
  readonly scored: number;
  readonly hits: number;
  readonly recallAt1: number;
  readonly mrr: number;
  readonly meanCandidates: number;
  /** NEGATIVE cases that returned a forbidden id — a scoping regression. */
  readonly falsePositives: number;
  /** POSITIVE cases where the expected skill never appeared at all. */
  readonly falseNegatives: number;
  /** COVERAGE-ONLY cases — excluded from every number above. */
  readonly coverageOnly: number;
  /** Of those, how many reached their expected skill at rank 1. Reachability, not quality. */
  readonly coverageReached: number;
}

/**
 * Aggregate.
 *
 * Recall and MRR are computed over SCORING cases only — positives that are not coverage-only —
 * matching `summarize` and `partitionCases` in `taxonomy-retrieval-eval.ts`. Two exclusions,
 * for two different reasons:
 *
 *   NEGATIVES have no correct answer to find. Dividing by all cases would let a fixture dilute
 *   its own recall by adding negatives, which is the opposite of what adding one is for.
 *
 *   COVERAGE-ONLY cases have an expected skill that is shipped-and-reused-only, with no
 *   locally-authored corpus record. They ask "is this reachable", not "is this ranked first",
 *   and the fixture says so in each case's own notes. This exclusion was MISSING here while
 *   `taxonomy-retrieval-eval.ts` and `taxonomy-alias-experiment.ts` both applied it — so the
 *   moment the last four `unembedded_shipped` queries got vectors, they entered Recall and
 *   moved a headline number that three other places agreed they should not touch. The number
 *   was reported before the disagreement was noticed, which is the real cost.
 */
export function summarizeReplay(rows: readonly ReplayCaseResult[]): ReplaySummary {
  const positives = rows.filter((r) => !r.negative && !r.coverageOnly);
  const coverage = rows.filter((r) => r.coverageOnly);
  const n = positives.length;
  const hits = positives.filter((r) => r.hit).length;
  const rr = positives.reduce((s, r) => s + (r.expectedRank === null ? 0 : 1 / r.expectedRank), 0);
  const cand = rows.reduce((s, r) => s + r.candidateCount, 0);
  return {
    cases: rows.length,
    resolved: rows.filter((r) => !r.unresolved).length,
    unresolved: rows.filter((r) => r.unresolved).length,
    scored: n,
    hits,
    recallAt1: n === 0 ? 0 : hits / n,
    mrr: n === 0 ? 0 : rr / n,
    meanCandidates: rows.length === 0 ? 0 : cand / rows.length,
    falsePositives: rows.filter((r) => r.negative && r.structuralViolations.length > 0).length,
    falseNegatives: positives.filter((r) => r.expectedRank === null).length,
    coverageOnly: coverage.length,
    coverageReached: coverage.filter((r) => r.hit).length,
  };
}

// ===========================================================================
// Reachability probe — the instrument the fixture is not allowed to be
// ===========================================================================

/**
 * Ask a skill family's own alias texts, in the domains it should serve, and report whether
 * retrieval can see it at all.
 *
 * WHY THIS IS NOT FIXTURE CASES. `validateEvalFixture` rejects any case whose expected skill is
 * not wired to the queried domain — `EXPECTED_SKILL_NOT_IN_SCOPE ... unpassable by
 * construction`. `skill_drawing_reading` has no edges, so the fixture CANNOT host coverage for
 * it until the edges exist. The instrument cannot be extended to observe the defect while the
 * defect exists. This probe answers the same question from outside the fixture.
 *
 * These are REACHABILITY probes, never ground truth. Every query is literally an alias of the
 * expected skill, so correctness is tautological — the DC-18 lesson, and the reason the result
 * must never be folded into recall. What it measures is not "does retrieval rank well" but
 * "can retrieval see this at all".
 *
 * `winsInstead` is the part that matters. A surface that returns NOTHING is a gap; a surface
 * that returns a confident, unrelated skill is a misclassification, and only this field tells
 * the two apart.
 */
export interface ProbeResult {
  readonly probes: number;
  /** Probes where some member of the family appeared anywhere in the top-k. */
  readonly familyReachable: number;
  /** Probes where a family member ranked first. */
  readonly familyTop1: number;
  /** What won when the family did not, most frequent first. */
  readonly winsInstead: readonly { skillId: string; count: number }[];
}

export function probeFamilyReachability(
  corpus: ReplayCorpus,
  args: {
    family: readonly string[];
    domains: readonly string[];
    vectorsByText: ReadonlyMap<string, readonly number[]>;
    texts: readonly string[];
    k: number;
    statuses?: readonly SkillStatus[];
  },
): ProbeResult {
  const family = new Set(args.family);
  const winners = new Map<string, number>();
  let probes = 0;
  let reachable = 0;
  let top1 = 0;

  for (const domain of args.domains) {
    const candidates = pathACandidates(corpus, domain, args.statuses);
    for (const text of args.texts) {
      const vec = args.vectorsByText.get(text);
      if (vec === undefined) continue;
      probes += 1;
      const ranked = rankSkillsFromAliases(rankAliases(vec, candidates, args.k));
      if (ranked.some((r) => family.has(r.skillId))) reachable += 1;
      const winner = ranked[0]?.skillId ?? "(nothing returned)";
      if (family.has(winner)) top1 += 1;
      else winners.set(winner, (winners.get(winner) ?? 0) + 1);
    }
  }

  return {
    probes,
    familyReachable: reachable,
    familyTop1: top1,
    winsInstead: [...winners.entries()]
      .map(([skillId, count]) => ({ skillId, count }))
      .sort((a, b) => b.count - a.count || a.skillId.localeCompare(b.skillId)),
  };
}

/** Agreement between two paths on the same phrases — D0 Phase D's parity metric. */
export interface AgreementSummary {
  readonly cases: number;
  readonly bothResolved: number;
  readonly agreeTop1: number;
  readonly disagreeTop1: number;
  readonly onlyAResolved: number;
  readonly onlyBResolved: number;
  readonly neitherResolved: number;
  readonly agreementRate: number;
}

export function summarizeAgreement(
  a: readonly ReplayCaseResult[],
  b: readonly ReplayCaseResult[],
): AgreementSummary {
  const byId = new Map(b.map((r) => [r.caseId, r]));
  let bothResolved = 0;
  let agree = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  for (const ra of a) {
    const rb = byId.get(ra.caseId);
    if (rb === undefined) continue;
    if (!ra.unresolved && !rb.unresolved) {
      bothResolved += 1;
      if (ra.top1SkillId === rb.top1SkillId) agree += 1;
    } else if (!ra.unresolved) onlyA += 1;
    else if (!rb.unresolved) onlyB += 1;
    else neither += 1;
  }
  return {
    cases: a.length,
    bothResolved,
    agreeTop1: agree,
    disagreeTop1: bothResolved - agree,
    onlyAResolved: onlyA,
    onlyBResolved: onlyB,
    neitherResolved: neither,
    agreementRate: bothResolved === 0 ? 0 : agree / bothResolved,
  };
}
