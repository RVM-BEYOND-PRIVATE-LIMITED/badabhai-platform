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
import { normalizeOccupationText, skeletonKey } from "@badabhai/profiling-lexicon";

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
 * The in-memory index. Two maps, both from a normalized key to the domains that claim it.
 *
 * A key can be claimed by SEVERAL domains — "mistri" is honestly ambiguous between a
 * mason and a general repairman, and "fitter" spans four unit groups. The index keeps
 * every claimant rather than picking one, because deciding between them is a Phase 7
 * calibration concern (family-level margin) and pretending it away here would flatter the
 * hit rate.
 */
export interface OccupationIndex {
  exact: Map<string, string[]>;
  skeleton: Map<string, string[]>;
  /** job_domain_id -> ISCO unit code, for scoring at family granularity. */
  unitByDomain: Map<string, string | null>;
  maxSpanTokens: number;
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const at = map.get(key);
  if (at === undefined) map.set(key, [id]);
  else if (!at.includes(id)) at.push(id);
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
  const exact = new Map<string, string[]>();
  const skeleton = new Map<string, string[]>();
  const unitByDomain = new Map<string, string | null>();
  let maxSpanTokens = 1;

  for (const d of corpus) {
    unitByDomain.set(d.jobDomainId, d.isco_unit);
    if (!d.selectable) continue;
    for (const a of d.aliases ?? []) {
      const norm = normalizeOccupationText(a.text);
      if (norm.length === 0) continue;
      push(exact, norm, d.jobDomainId);
      const skel = skeletonKey(norm);
      if (skel.length > 0) push(skeleton, skel, d.jobDomainId);
      const tokens = norm.split(" ").length;
      if (tokens > maxSpanTokens) maxSpanTokens = tokens;
    }
  }
  return { exact, skeleton, unitByDomain, maxSpanTokens };
}

/**
 * Longest-first span search over the normalized utterance.
 *
 * Windows are capped at the longest alias in the index: a span longer than any alias can
 * never match, so scanning it is pure waste on every utterance. With ~9k aliases the cap
 * is small (single digits), which keeps this O(tokens x cap) rather than O(tokens^2).
 *
 * L0 is exhausted at EVERY span length before L1 is tried at any length. Trying L1 at a
 * long span before L0 at a short one would let a fuzzy skeleton match beat an exact one,
 * which inverts the whole point of the ladder.
 */
export function resolveOccupation(index: OccupationIndex, utterance: string): RetrievalHit | null {
  const norm = normalizeOccupationText(utterance);
  if (norm.length === 0) return null;
  const tokens = norm.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const spans: { span: string; len: number }[] = [];
  const cap = Math.min(tokens.length, index.maxSpanTokens);
  for (let len = cap; len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      spans.push({ span: tokens.slice(i, i + len).join(" "), len });
    }
  }

  for (const { span, len } of spans) {
    const first = index.exact.get(span)?.[0];
    if (first !== undefined) return { jobDomainId: first, layer: "L0", span, spanTokens: len };
  }
  for (const { span, len } of spans) {
    const skel = skeletonKey(span);
    if (skel.length === 0) continue;
    const first = index.skeleton.get(skel)?.[0];
    if (first !== undefined) return { jobDomainId: first, layer: "L1", span, spanTokens: len };
  }
  return null;
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
