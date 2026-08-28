/**
 * L0/L1 occupation retrieval, and the harness that measures it against a gold set.
 *
 * WHY THIS EXISTS IN packages/db AND NOT IN apps/api. Phase 7 owns the production
 * retrieval service (`OccupationIndexService`, backed by Postgres). This file is not that
 * service: it is a MEASUREMENT tool that answers one question — "with vector retrieval
 * switched off, how often do the worker's own words reach the right occupation?" — which
 * is the Phase 2 acceptance criterion. It reads the committed corpus and the shared
 * normalizer, never the database, so the number it produces is a property of the CORPUS
 * and is reproducible from a git checkout alone.
 *
 * THE TWO LAYERS, and why only these two.
 *   L0 exact    — normalized alias hash lookup. Free, ~2 ms in production.
 *   L1 skeleton — the same lookup over `skeletonKey`, which folds the Hinglish confusions
 *                 (kh/k, w/v, z/j, sh/s, vowel drop) so `welder`/`waelder`/`velder` and
 *                 `kharad`/`kharaad` collapse together.
 * L2 (trigram) and L3 (vector) both need Postgres and are therefore not measurable here.
 * That is deliberate: the plan's constraint is that the product must work with vectors
 * OFF, so the gate that matters is the one that needs neither an index nor a provider.
 *
 * SPAN SEARCH IS THE INTERESTING PART. A worker does not say "welder"; they say "main
 * pichhle char saal se welding ka kaam karta hoon". An exact hash lookup on that whole
 * string matches nothing, so the resolver tries contiguous token windows LONGEST FIRST.
 * Longest-first matters for precision, not just recall: "gas welding" must beat "welding"
 * when both are present, because the longer span carries the more specific occupation and
 * picking the shorter one would silently discard the worker's own qualifier.
 *
 * PRIVACY: operates on committed corpus text and a committed gold set. The gold set is
 * pseudonymized before it is written — see the header of `occupation-gold.jsonl`.
 */
import { buildSpanIndex, matchSpan, type SpanIndex } from "@badabhai/profiling-lexicon";

import type { ResolvedJobDomain } from "./job-domain-corpus";

/** Which layer produced a hit. `null` when nothing matched. */
export type RetrievalLayer = "L0" | "L1";

export interface RetrievalHit {
  jobDomainId: string;
  layer: RetrievalLayer;
  /** The matched span, normalized — what a human needs to see to judge a bad hit. */
  span: string;
  /** Token count of the matched span. Longer spans are more specific. */
  spanTokens: number;
}

/**
 * The in-memory index: the shared span index plus the one thing scoring needs that span
 * search has no business knowing about — which ISCO unit each domain belongs to.
 *
 * THE SEARCH ITSELF IS NOT DEFINED HERE. `buildSpanIndex`/`matchSpan` live in
 * `@badabhai/profiling-lexicon` and are the same functions `OccupationIndexService` runs
 * in production. That is deliberate and it is the whole point of this harness: a hit rate
 * measured by a *different* algorithm from the one that serves workers is a number about
 * nothing. `occupation-retrieval-parity.test.ts` pins the two together.
 */
export interface OccupationIndex {
  spans: SpanIndex;
  /** job_domain_id -> ISCO unit code, for scoring at family granularity. */
  unitByDomain: Map<string, string | null>;
}

/**
 * Build the index from the resolved corpus.
 *
 * ONLY SEARCHABLE-ELIGIBLE ROWS ARE INDEXED. `is_searchable` is a database column
 * computed by `db:normalize:aliases`, and this harness never touches the database — so it
 * recomputes the part of that predicate the corpus can answer (`selectable`), which is
 * the clause that matters for recall. The other two clauses (shadowing, dedupe) only ever
 * REMOVE rows that would have been redundant or unreachable anyway, so an offline number
 * computed this way is a faithful lower bound rather than an optimistic one.
 */
export function buildOccupationIndex(corpus: ResolvedJobDomain[]): OccupationIndex {
  const unitByDomain = new Map<string, string | null>();
  const entries: { id: string; aliases: string[] }[] = [];

  for (const d of corpus) {
    unitByDomain.set(d.jobDomainId, d.isco_unit);
    if (!d.selectable) continue;
    entries.push({ id: d.jobDomainId, aliases: (d.aliases ?? []).map((a) => a.text) });
  }

  return { spans: buildSpanIndex(entries), unitByDomain };
}

/**
 * Resolve one occupation from an utterance — the shared span search, narrowed to a single
 * winner for scoring.
 *
 * TAKING `ids[0]` IS A MEASUREMENT CHOICE, NOT PRODUCTION BEHAVIOUR. A span can be claimed
 * by several domains, and production hands all of them to the family-level margin so the
 * engine can refuse to guess between two different trades. A gold-set score has no such
 * option: it needs one answer per utterance. Taking the first claimant is the pessimistic
 * reading — the harness gets no credit for an ambiguity it did not resolve — which keeps
 * the published number a lower bound rather than a flattering one.
 */
export function resolveOccupation(index: OccupationIndex, utterance: string): RetrievalHit | null {
  const hit = matchSpan(index.spans, utterance);
  if (hit === null) return null;
  return {
    jobDomainId: hit.ids[0] as string,
    layer: hit.layer,
    span: hit.span,
    spanTokens: hit.spanTokens,
  };
}

/** One labelled utterance. `expect_unit` is the ISCO unit code the answer must fall in. */
export interface GoldUtterance {
  utterance: string;
  expect_unit: string;
  /** Free-text note on why this case is interesting. Never asserted on. */
  note?: string;
}

export interface EvalResult {
  total: number;
  l0: number;
  l1: number;
  miss: number;
  /** Hit but in the WRONG unit group — the failure that matters most. */
  wrongUnit: number;
  /** (l0 + l1 correct) / total, the Phase 2 acceptance number. */
  hitRate: number;
  /** Correct-unit hits over hits attempted — precision of what it did answer. */
  precision: number;
  failures: { utterance: string; expected: string; got: string | null; layer: RetrievalLayer | null }[];
}

/**
 * Resolve an ISCO unit code, or a job domain, to the family that owns its question pack.
 *
 * Supplied by the caller rather than imported, so this module stays free of the pack
 * corpus — it measures RETRIEVAL, and a hard dependency on pack data would make the
 * Phase 2 number unmeasurable whenever the pack corpus happened to be mid-edit.
 */
export type FamilyLookup = (jobDomainId: string, iscoUnitCode: string | null) => string | null;

export interface FamilyEvalResult {
  total: number;
  /** Resolved to the family the label implies. */
  correct: number;
  /** Resolved to a DIFFERENT family — the failure that makes every later question wrong. */
  wrongFamily: number;
  /**
   * Resolved to a MORE SPECIFIC family under the gold row's own ISCO unit — counted with
   * `correct`, reported separately so it can never absorb a real error unnoticed.
   */
  refined: number;
  /** Nothing matched, so no family was claimed. Not a precision failure. */
  miss: number;
  /** Gold rows whose expected unit binds to no family at all. Excluded from precision. */
  unbound: number;
  /** (correct + refined) / (correct + refined + wrongFamily) — the plan's ≥0.97 criterion. */
  precision: number;
  /** (correct + refined) / total — how much of the gold set it answers correctly at all. */
  coverage: number;
  failures: { utterance: string; expectedFamily: string; gotFamily: string | null; got: string | null }[];
  /** Every refinement, so the reviewer sees which families the gold set cannot express. */
  refinements: { utterance: string; expectedFamily: string; gotFamily: string }[];
}

/**
 * Score the gold set at FAMILY level — the plan's Phase 7 acceptance criterion.
 *
 * WHY THIS IS THE NUMBER THAT MATTERS, and unit-level precision is not. A family owns the
 * question pack, so a wrong family means every subsequent question in the interview is
 * about the wrong trade — twelve questions about welding for a tailor, and an abandoned
 * interview. A wrong OCCUPATION inside the right family costs nothing at all: the pack is
 * the same, and the exact NCO code is settled afterwards by the pack's own first question.
 *
 * `scoreGoldSet` scores at ISCO unit as a proxy, which was the only option before
 * `profiling_family` existed. It is a PESSIMISTIC proxy — "Welder, Gas" and "Welder,
 * Electric" are different units in some branches but one family — so the unit number is a
 * lower bound on this one, and the two are reported side by side rather than one replacing
 * the other.
 *
 * ROWS WHOSE EXPECTED UNIT BINDS TO NOTHING ARE EXCLUDED, not counted as failures. A gold
 * utterance labelled to a unit with no family is a gap in the PACK corpus, not a retrieval
 * error, and folding it into precision would make the retrieval number move whenever pack
 * authoring moved.
 */
export function scoreGoldSetByFamily(
  index: OccupationIndex,
  gold: GoldUtterance[],
  familyOf: FamilyLookup,
): FamilyEvalResult {
  let correct = 0;
  let wrongFamily = 0;
  let refined = 0;
  let miss = 0;
  let unbound = 0;
  const failures: FamilyEvalResult["failures"] = [];
  const refinements: FamilyEvalResult["refinements"] = [];

  for (const g of gold) {
    // The expected family comes from the LABEL's unit code, resolved through the same
    // chain production uses. A synthetic domain id is passed because the label names a
    // unit, not an occupation — so only the unit-and-above levels can match, which is
    // exactly the granularity the gold set was labelled at.
    const expected = familyOf(`__gold__${g.expect_unit}`, g.expect_unit);
    if (expected === null) {
      unbound++;
      continue;
    }

    const hit = resolveOccupation(index, g.utterance);
    if (hit === null) {
      miss++;
      failures.push({ utterance: g.utterance, expectedFamily: expected, gotFamily: null, got: null });
      continue;
    }

    const gotUnit = index.unitByDomain.get(hit.jobDomainId) ?? null;
    const got = familyOf(hit.jobDomainId, gotUnit);
    if (got === expected) {
      correct++;
      continue;
    }

    // A MORE SPECIFIC FAMILY UNDER THE SAME UNIT IS NOT A WRONG ANSWER, and the metric could
    // not say so until a family bound below unit level actually existed.
    //
    // `expected` is resolved through a SYNTHETIC domain id (`__gold__<unit>`), because the gold
    // set is labelled to a unit rather than to an occupation. Only unit-and-above bindings can
    // match it. So the moment a family binds by `job_domain_id` — `fam_cnc_turning` under ISCO
    // 7223, alongside `fam_machining` which binds the whole unit — every utterance that family
    // exists to serve scores as WRONG, permanently and by construction. Measured on this
    // branch: ten failures, every one of them "kharad", "lathe machine" or "cnc turning ka
    // kaam" resolving to the turning family. The retrieval was RIGHTER than the label.
    //
    // WHY SAME-UNIT IS A SOUND TEST OF REFINEMENT rather than a convenient one. `resolveFamily`
    // picks the most specific matching binding. `expected` cannot resolve below unit level, so
    // if the hit's unit equals the gold's unit and the families still differ, the only thing
    // that can have produced the difference is a domain-level binding INSIDE that unit — which
    // is the definition of a refinement. A wrong unit makes the units differ and still counts
    // against precision, so this cannot launder a real cross-trade error: "silai mashin" landing
    // in `fam_tailoring` remains a failure, as it should.
    if (got !== null && gotUnit !== null && gotUnit === g.expect_unit) {
      refined++;
      refinements.push({ utterance: g.utterance, expectedFamily: expected, gotFamily: got });
      continue;
    }

    wrongFamily++;
    failures.push({
      utterance: g.utterance,
      expectedFamily: expected,
      gotFamily: got,
      got: hit.jobDomainId,
    });
  }

  // Refinements count with `correct`: the interview they produce is the RIGHT pack, which is
  // the entire thing this criterion exists to protect.
  const right = correct + refined;
  const attempted = right + wrongFamily;
  const total = gold.length;
  return {
    total,
    correct,
    wrongFamily,
    refined,
    miss,
    unbound,
    precision: attempted === 0 ? 0 : right / attempted,
    coverage: total - unbound === 0 ? 0 : right / (total - unbound),
    failures,
    refinements,
  };
}

/**
 * Score a gold set.
 *
 * SCORED AT ISCO-UNIT LEVEL, NOT AT OCCUPATION LEVEL, and this is the plan's own
 * reasoning: NCO is over-granular for conversation. "Welder, Gas" versus "Welder,
 * Electric" is a coin flip at occupation level and identical at family level — they share
 * a question pack, so resolving to either is a SUCCESS for the interview. Scoring at
 * occupation level would report failure for an outcome the product treats as correct.
 * ISCO unit is used as the family proxy because `profiling_family` does not exist until
 * Phase 4; when it does, swap `unitByDomain` for the family binding and the harness is
 * unchanged.
 */
export function scoreGoldSet(index: OccupationIndex, gold: GoldUtterance[]): EvalResult {
  let l0 = 0;
  let l1 = 0;
  let miss = 0;
  let wrongUnit = 0;
  const failures: EvalResult["failures"] = [];

  for (const g of gold) {
    const hit = resolveOccupation(index, g.utterance);
    if (hit === null) {
      miss++;
      failures.push({ utterance: g.utterance, expected: g.expect_unit, got: null, layer: null });
      continue;
    }
    const unit = index.unitByDomain.get(hit.jobDomainId) ?? null;
    if (unit !== g.expect_unit) {
      wrongUnit++;
      failures.push({ utterance: g.utterance, expected: g.expect_unit, got: hit.jobDomainId, layer: hit.layer });
      continue;
    }
    if (hit.layer === "L0") l0++;
    else l1++;
  }

  const total = gold.length;
  const correct = l0 + l1;
  const attempted = total - miss;
  return {
    total,
    l0,
    l1,
    miss,
    wrongUnit,
    hitRate: total === 0 ? 0 : correct / total,
    precision: attempted === 0 ? 0 : correct / attempted,
    failures,
  };
}
