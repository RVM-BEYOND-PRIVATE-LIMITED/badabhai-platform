/**
 * Retrieval metrics for the taxonomy evaluation harness — Recall@k, MRR, competitor
 * outranking, structural isolation.
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
 *
 * ===========================================================================
 * EVALUATOR v2 — WHAT CHANGED, AND WHY THE OLD NUMBER WAS WRONG
 * ===========================================================================
 * v1 scored `must_not_return_skill_ids` as TOP-K MEMBERSHIP: a forbidden id anywhere in the
 * top k counted as a leak. Against the Phase 5 corpus that produced `lexical_ambiguity`
 * leak = 72.7%, which was reported and then diagnosed as an artifact of the metric rather
 * than a property of the model. The diagnosis, per case:
 *
 *   in all 8 "leaks" the EXPECTED skill was already at rank 1, and the forbidden sibling sat
 *   0.19-0.46 cosine BELOW it.
 *
 * The cause is structural, not incidental. A domain in this corpus wires 6-11 skills, and
 * `k = 5`. Top-5 membership therefore covers most of the candidate pool by construction, so
 * "did a competitor appear at all" asks a question whose answer is nearly always yes and is
 * governed by pool size rather than by ranking. It is unfalsifiable in the direction that
 * matters: it cannot distinguish "the model confused these two" from "the domain is small".
 *
 * v2 replaces it with the assertion the fixture actually meant:
 *
 *   A FORBIDDEN SKILL MUST NOT OUTRANK THE EXPECTED SKILL.
 *
 * That is falsifiable at any pool size, it is invariant to k, and it fails exactly when the
 * model has genuinely preferred the wrong sibling. `must_not_return_skill_ids` keeps its
 * name — the fixture field is unchanged — but the JUDGEMENT applied to it is now relative
 * position, not presence.
 *
 * ---------------------------------------------------------------------------
 * THE TWO MEASURES ARE REPORTED SEPARATELY AND MUST NOT BE ADDED TOGETHER
 * ---------------------------------------------------------------------------
 * They answer different questions and only one of them is about the model.
 *
 *   SEMANTIC — `competitor_outranking_rate`. Positive cases only. The forbidden ids are
 *     IN-SCOPE competitors (the fixture gate enforces that), so both skills are genuinely
 *     retrievable and the ordering between them is a real ranking decision. A non-zero rate
 *     here is a model/taxonomy finding.
 *
 *   STRUCTURAL — `structural_isolation_violations`. Negative cases only. The forbidden ids
 *     are OUT of scope (the fixture gate enforces that too), so the `job_domain_skill` INNER
 *     JOIN makes returning one impossible unless the scoping itself has regressed. A zero
 *     here is a passing regression guard on the QUERY, and is never evidence that the model
 *     separates domains well — no model was consulted. Reporting it as "0% leakage" invites
 *     precisely that misreading, which is why it no longer shares a field with the semantic
 *     measure, or a name with the word "leakage".
 */

/** One (skill, score) candidate as the retrieval query returned it — alias-grained. */
export interface RetrievedRow {
  skill_id: string;
  /** Cosine SIMILARITY (`1 - (embedding <=> q)`), higher is better. */
  score: number;
}

/**
 * Evaluator semantics version, stamped into every run record.
 *
 * 1 = Phase 5 baseline. `must_not_return_skill_ids` judged as top-k MEMBERSHIP; one
 *     combined `cross_domain_leakage_rate` spanning positive and negative cases.
 * 2 = Phase 6. Judged as RELATIVE POSITION against the expected skill; the semantic and
 *     structural measures separated into two fields.
 *
 * It exists so a report can never silently compare a v1 number with a v2 one. The Phase 5
 * baseline is preserved unmodified and is a v1 record; the correction run is a v2 record,
 * and the difference between them is a measurement change, not a model change.
 */
export const EVALUATOR_VERSION = 2;

/** What a single evaluated query produced. */
export interface CaseOutcome {
  /** 1-based rank of the first correct skill, or null when it never appeared. */
  rank: number | null;
  /** `1/rank`, or 0 when absent — the reciprocal rank this case contributes to MRR. */
  reciprocalRank: number;
  /**
   * POSITIVE cases: forbidden IN-SCOPE competitors that placed ABOVE the first correct
   * skill, in rank order. Empty when the expected skill won, however many competitors also
   * appeared. This is the semantic failure.
   */
  outranked: string[];
  /**
   * Did this case ASSERT anything about a competitor at all — i.e. declare a non-empty
   * `must_not_return_skill_ids`? Carried explicitly because `outranked: []` is ambiguous
   * on its own: it means both "a competitor was asserted and the expected skill beat it"
   * and "nothing was ever asserted". Aggregating those together publishes an outranking
   * rate whose denominator is mostly cases that could not have failed it.
   */
  assertsCompetitor: boolean;
  /**
   * NEGATIVE cases: forbidden OUT-OF-SCOPE ids that came back at all. Non-empty means the
   * `job_domain_skill` scoping is broken, which is a query regression, not a model result.
   */
  structuralViolations: string[];
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
 * `k` truncates BEFORE anything is judged, so every verdict describes the same result list
 * an application would actually consume. Judging an untruncated list would report failures
 * nobody could ever see.
 */
export function evaluateCase(target: CaseTarget, rows: readonly RetrievedRow[], k: number): CaseOutcome {
  if (!Number.isInteger(k) || k < 1) throw new Error(`evaluateCase: k must be a positive integer, got ${k}`);
  const ranked = rankSkills(rows).slice(0, k);
  const ids = ranked.map((r) => r.skill_id);

  const correct = new Set<string>();
  if (target.expected_skill_id !== null) correct.add(target.expected_skill_id);
  for (const alt of target.acceptable_skill_ids ?? []) correct.add(alt);

  const forbidden = new Set(target.must_not_return_skill_ids ?? []);
  const empty = rows.length === 0;

  // ── NEGATIVE case ────────────────────────────────────────────────────────
  // Nothing to outrank, so "did it appear" is the only question there is — and here it is
  // the RIGHT question, because these ids are out of scope and the join should have made
  // them unreachable. A hit is a scoping regression.
  if (correct.size === 0) {
    return {
      rank: null,
      reciprocalRank: 0,
      outranked: [],
      assertsCompetitor: false,
      structuralViolations: ids.filter((id) => forbidden.has(id)),
      empty,
      ranked: ids,
    };
  }

  // ── POSITIVE case ────────────────────────────────────────────────────────
  const idx = ids.findIndex((id) => correct.has(id));
  const rank = idx === -1 ? null : idx + 1;
  // The expected skill's position is the bar. When it never appeared, its position is
  // effectively infinite, so EVERY forbidden id present cleared the bar — which is the
  // case the "must not outrank" wording exists to catch, and the one a naive
  // `position < rank` comparison would silently score as clean by comparing against null.
  const bar = idx === -1 ? ids.length : idx;
  return {
    rank,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    outranked: ids.slice(0, bar).filter((id) => forbidden.has(id)),
    assertsCompetitor: forbidden.size > 0,
    structuralViolations: [],
    empty,
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
  /**
   * SEMANTIC. Of the positive cases that ASSERTED a competitor, the share where that
   * competitor placed above the expected skill.
   *
   * The denominator is `competitor_asserting_cases`, NOT every positive case. Dividing by
   * all positives would make the rate a function of how many assertions the fixture happens
   * to carry — 8 outranked out of 11 asserting cases reads 72.7%, the same 8 out of 123
   * positives reads 6.5%, and neither the model nor the corpus changed between them. That
   * denominator drift is the same class of defect as the v1 membership test.
   *
   * `null` when the group asserted nothing — never 0, which would read as "measured clean".
   */
  competitor_outranking_rate: number | null;
  /** Positive cases carrying at least one in-scope forbidden id. The rate's denominator,
   *  reported beside it so the rate is never read without its sample size. */
  competitor_asserting_cases: number;
  competitor_outranked_cases: number;
  /**
   * STRUCTURAL. Negative cases in this group, and how many returned an out-of-scope
   * forbidden id. A regression guard on `job_domain_skill` scoping. NOT a model measure —
   * see the header. Reported as counts, deliberately not as a rate: a rate invites being
   * quoted as "0% leakage".
   */
  structural_isolation_cases: number;
  structural_isolation_violations: number;
  /** Share of POSITIVE cases that returned nothing at all. */
  no_result_rate: number | null;
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
 * real result. The same rule governs `competitor_outranking_rate`.
 */
export function summarize(cases: readonly ScoredCase[], k = 5): MetricSummary {
  const positives = cases.filter((c) => c.positive);
  const negatives = cases.filter((c) => !c.positive);
  const n = positives.length;
  const hitsWithin = (at: number): number => positives.filter((c) => c.outcome.rank !== null && c.outcome.rank <= at).length;
  const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  const ratio = (x: number): number => round4(x / n);
  // Recall@N is UNMEASURABLE when the run only fetched k < N candidates: every case was
  // truncated at k, so Recall@5 from a k=1 run would just be Recall@1 wearing a bigger
  // label. Report null rather than a number that is right about the wrong question.
  const recallAt = (at: number): number | null => (n === 0 || at > k ? null : ratio(hitsWithin(at)));
  const outranked = positives.filter((c) => c.outcome.outranked.length > 0).length;
  const asserting = positives.filter((c) => c.outcome.assertsCompetitor).length;
  return {
    queries: cases.length,
    scored: n,
    recall_at_1: recallAt(1),
    recall_at_3: recallAt(3),
    recall_at_5: recallAt(5),
    mrr: n === 0 ? null : round4(positives.reduce((s, c) => s + c.outcome.reciprocalRank, 0) / n),
    competitor_outranking_rate: asserting === 0 ? null : round4(outranked / asserting),
    competitor_asserting_cases: asserting,
    competitor_outranked_cases: outranked,
    structural_isolation_cases: negatives.length,
    structural_isolation_violations: negatives.filter((c) => c.outcome.structuralViolations.length > 0).length,
    no_result_rate: n === 0 ? null : ratio(positives.filter((c) => c.outcome.empty).length),
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
