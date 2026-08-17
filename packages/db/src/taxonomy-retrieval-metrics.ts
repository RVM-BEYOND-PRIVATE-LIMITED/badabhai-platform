/**
 * Retrieval metrics for the taxonomy evaluation harness — Recall@k, MRR, leakage.
 *
 * PURE. No database, no provider, no clock, no filesystem. Given the same retrieved rows
 * this returns the same numbers, which is the only way a metric is worth arguing about.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RANKING IS RE-DERIVED HERE INSTEAD OF TRUSTED FROM SQL
 * ---------------------------------------------------------------------------
 * The retrieval query returns one row per matching ALIAS, ordered by distance. Two things
 * make that unusable as a rank directly:
 *
 *   1. ONE SKILL, MANY ALIASES. "Forklift operation" has `forklift driving` and `फोर्कलिफ्ट`;
 *      both can land in the top 5. Counting them as two ranks would let a single skill
 *      occupy the whole result list and make Recall@5 measure alias count rather than
 *      retrieval. Rank is therefore per SKILL: dedupe to the best-scoring alias.
 *
 *   2. TIES ARE NOT ORDERED. Equal cosine distances come back in whatever order the index
 *      scan produced, which is stable in practice and guaranteed nowhere. A metric that
 *      changes when Postgres changes its mind is not a measurement. Ties break on
 *      `skill_id` ascending — arbitrary, but FIXED, which is the property that matters.
 *
 * ---------------------------------------------------------------------------
 * WHAT "CORRECT" MEANS
 * ---------------------------------------------------------------------------
 * `expected_skill_id` plus `acceptable_skill_ids`. The alternatives exist because some
 * queries are honestly ambiguous against this corpus — "material handling" legitimately
 * answers to both `skill_material_handling_equipment_operation` and `skill_forklift_operation`
 * inside a warehouse domain. Marking one wrong would measure fixture opinion, not retrieval.
 *
 * They are NOT a way to make a failing query pass: every alternative is reviewed and carries
 * its own justification in the fixture, and `validateEvalFixture` refuses an alternative that
 * is not wired to the same domain as the expected skill.
 */

/** One (skill, score) candidate as the retrieval query returned it — alias-grained. */
export interface RetrievedRow {
  skill_id: string;
  /** Cosine SIMILARITY (`1 - (embedding <=> q)`), higher is better. */
  score: number;
}

/** What a single evaluated query produced. */
export interface CaseOutcome {
  /** 1-based rank of the first correct skill, or null when it never appeared. */
  rank: number | null;
  /** `1/rank`, or 0 when absent — the reciprocal rank this case contributes to MRR. */
  reciprocalRank: number;
  /** Skills the case declared must NOT come back, that did (within `k`). */
  leaked: string[];
  /** True when retrieval returned nothing at all. */
  empty: boolean;
  /** Skill ids after dedupe + deterministic ordering, truncated to `k`. */
  ranked: string[];
}

/**
 * Collapse alias-grained rows to a deterministic skill ranking.
 *
 * Keeps each skill's BEST score, then orders by score DESC, `skill_id` ASC. Exported
 * because the tie-break is the part most likely to be "simplified" later, and a test has
 * to be able to reach it.
 */
export function rankSkills(rows: readonly RetrievedRow[]): { skill_id: string; score: number }[] {
  const best = new Map<string, number>();
  for (const r of rows) {
    // COERCE. Production's repository does the same (`score: string | number` -> Number)
    // because a driver returning numerics as strings would make `>` a LEXICOGRAPHIC compare
    // here while the sort below stays numeric — a silently wrong best-alias pick.
    const score = Number(r.score);
    const seen = best.get(r.skill_id);
    if (seen === undefined || score > seen) best.set(r.skill_id, score);
  }
  return [...best.entries()]
    .map(([skill_id, score]) => ({ skill_id, score }))
    // CODEPOINT order, not localeCompare. `localeCompare` is ICU-collation dependent — it
    // ignores punctuation differences, so "skill_co2_welding" vs "skill_co2welding" can
    // order differently across Node/ICU versions. A tie-break that moves between machines
    // makes the metric irreproducible, which is the one thing it must not be.
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.skill_id < b.skill_id ? -1 : 1));
}

/** The correctness target of one case: the expected skill plus any reviewed alternatives. */
export interface CaseTarget {
  /** null for a NEGATIVE case — one that must retrieve nothing relevant. */
  expected_skill_id: string | null;
  acceptable_skill_ids?: readonly string[];
  must_not_return_skill_ids?: readonly string[];
}

/**
 * Score one query.
 *
 * `k` truncates BEFORE anything is judged, so leakage and rank describe the same result
 * list an application would actually consume. Judging leakage over an untruncated list
 * would report leaks nobody could ever see.
 */
export function evaluateCase(target: CaseTarget, rows: readonly RetrievedRow[], k: number): CaseOutcome {
  if (!Number.isInteger(k) || k < 1) throw new Error(`evaluateCase: k must be a positive integer, got ${k}`);
  const ranked = rankSkills(rows).slice(0, k);
  const ids = ranked.map((r) => r.skill_id);

  const correct = new Set<string>();
  if (target.expected_skill_id !== null) correct.add(target.expected_skill_id);
  for (const alt of target.acceptable_skill_ids ?? []) correct.add(alt);

  const forbidden = new Set(target.must_not_return_skill_ids ?? []);
  const leaked = ids.filter((id) => forbidden.has(id));

  // A negative case has no rank to find. Reporting rank 0 or 1 for it would fold a
  // "correctly returned nothing" into the same average as a "found it first", which are
  // opposite outcomes.
  if (correct.size === 0) {
    return { rank: null, reciprocalRank: 0, leaked, empty: rows.length === 0, ranked: ids };
  }

  const idx = ids.findIndex((id) => correct.has(id));
  const rank = idx === -1 ? null : idx + 1;
  return {
    rank,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    leaked,
    empty: rows.length === 0,
    ranked: ids,
  };
}

/** Aggregated numbers for one group of cases (a category, a domain, or everything). */
export interface MetricSummary {
  queries: number;
  /** POSITIVE cases only — the ones with a correct answer to find. */
  scored: number;
  recall_at_1: number | null;
  recall_at_3: number | null;
  recall_at_5: number | null;
  mrr: number | null;
  /** Share of cases (positive AND negative) that returned a forbidden skill. */
  cross_domain_leakage_rate: number;
  /** Share of POSITIVE cases that returned nothing at all. */
  no_result_rate: number | null;
  /** Negative cases that correctly stayed clean. */
  negative_cases: number;
  negative_clean: number;
}

/** One scored case, as the aggregator consumes it. */
export interface ScoredCase {
  positive: boolean;
  outcome: CaseOutcome;
}

/**
 * Aggregate a group.
 *
 * Recall/MRR are computed over POSITIVE cases only and are `null` when there are none —
 * never 0. A group of pure negatives scoring "Recall@1 = 0" reads as total failure when it
 * is actually "not applicable", and that misreading is exactly how an aggregate hides a
 * real result. Leakage spans both kinds, because a negative case exists to measure it.
 */
export function summarize(cases: readonly ScoredCase[], k = 5): MetricSummary {
  const positives = cases.filter((c) => c.positive);
  const negatives = cases.filter((c) => !c.positive);
  const n = positives.length;
  const hitsWithin = (at: number): number => positives.filter((c) => c.outcome.rank !== null && c.outcome.rank <= at).length;
  const ratio = (x: number): number => Math.round((x / n) * 10_000) / 10_000;
  // Recall@N is UNMEASURABLE when the run only fetched k < N candidates: every case was
  // truncated at k, so Recall@5 from a k=1 run would just be Recall@1 wearing a bigger
  // label. Report null rather than a number that is right about the wrong question.
  const recallAt = (at: number): number | null => (n === 0 || at > k ? null : ratio(hitsWithin(at)));
  return {
    queries: cases.length,
    scored: n,
    recall_at_1: recallAt(1),
    recall_at_3: recallAt(3),
    recall_at_5: recallAt(5),
    mrr: n === 0 ? null : Math.round((positives.reduce((s, c) => s + c.outcome.reciprocalRank, 0) / n) * 10_000) / 10_000,
    cross_domain_leakage_rate:
      cases.length === 0
        ? 0
        : Math.round((cases.filter((c) => c.outcome.leaked.length > 0).length / cases.length) * 10_000) / 10_000,
    no_result_rate: n === 0 ? null : ratio(positives.filter((c) => c.outcome.empty).length),
    negative_cases: negatives.length,
    negative_clean: negatives.filter((c) => c.outcome.leaked.length === 0).length,
  };
}

/**
 * Group summaries plus the overall one.
 *
 * The per-group breakdown is not a convenience. A single headline number over a fixture
 * whose domains are unevenly sized lets a strong group carry a broken one — the failure
 * this whole harness is supposed to catch — so the report always carries both, and the
 * group sizes alongside them.
 */
export function summarizeBy<T extends string>(
  cases: readonly (ScoredCase & { group: T })[],
  k = 5,
): { overall: MetricSummary; groups: Record<string, MetricSummary> } {
  const groups: Record<string, MetricSummary> = {};
  for (const g of [...new Set(cases.map((c) => c.group))].sort()) {
    groups[g] = summarize(cases.filter((c) => c.group === g), k);
  }
  return { overall: summarize(cases, k), groups };
}
