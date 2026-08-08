/**
 * Span search over the alias index — retrieval layers L0 and L1, shared by every reader.
 *
 * WHY THIS IS SHARED CODE AND NOT TWO IMPLEMENTATIONS. Two things resolve an occupation
 * from a worker's words: `packages/db/src/occupation-retrieval-eval.ts`, which measures the
 * hit rate against the gold set from a git checkout, and `OccupationIndexService`, which
 * answers it live from the database. If those two search differently, the eval publishes a
 * number production does not reproduce — an acceptance criterion that measures nothing.
 *
 * That is not hypothetical. Phase 4 extracted `resolveFamily` "so Phase 7's service can use
 * it" and then never exported it; the service wrote a second copy, the two disagreed about
 * a 3-digit ISCO code, and the same worker resolved to a real family in the deploy gate and
 * to universal in the engine. One decision, one implementation, or eventually two answers.
 *
 * WHAT IS HERE AND WHAT IS NOT. This module owns the *text* half of retrieval: normalize,
 * enumerate spans, look them up. It knows nothing about occupations, families, packs,
 * scores or the database — its index maps a string key to opaque ids, and the caller
 * decides what those ids mean. L2 (trigram) and L3 (vector) need Postgres and live in
 * `OccupationRepository`; they are not, and cannot be, part of this file.
 *
 * PRIVACY: pure text transformation. Holds no state and writes nothing.
 */
import { normalizeOccupationText, skeletonKey } from "../normalize/index.js";

/** Which lexical layer produced a match. */
export type SpanLayer = "L0" | "L1";

/**
 * One entry to index: an id and every surface form that should reach it.
 *
 * Deliberately not "a job domain". The eval harness builds these from the committed
 * corpus and the service builds them from `job_domain_alias` rows; forcing both through
 * one shape is what makes the shared search honest, and neither shape belongs here.
 */
export interface IndexableEntry {
  readonly id: string;
  readonly aliases: readonly string[];
}

/**
 * The in-memory index. Two maps from a normalized key to every id that claims it.
 *
 * A KEY CAN HAVE SEVERAL CLAIMANTS AND THE INDEX KEEPS THEM ALL. "mistri" is honestly
 * ambiguous between a mason and a general repairman; "fitter" spans four unit groups.
 * Collapsing them to one at index time would hide the ambiguity from the only component
 * equipped to handle it — the family-level margin in `occupation-calibration.ts`, which
 * needs to SEE two candidates in order to refuse to guess between them.
 */
export interface SpanIndex {
  readonly exact: ReadonlyMap<string, readonly string[]>;
  readonly skeleton: ReadonlyMap<string, readonly string[]>;
  /** Longest alias, in tokens. Caps the span scan — see {@link matchSpan}. */
  readonly maxSpanTokens: number;
  /**
   * token -> the ids whose aliases contain it, plus each token's inverse document frequency.
   *
   * WHAT THIS IS FOR, since it is emphatically NOT a fifth retrieval layer. `matchSpan`
   * answers "which ids claim this span". When several claim the SAME span — "mistri"
   * reaches a mason and a general repairman — every candidate has identical evidence, and
   * neither the index nor the caller has any way to prefer one. The postings let the REST
   * of the worker's sentence break that tie: "raj mistri deewar banata hoon" contains
   * `deewar`, which belongs to masonry and not to general repair.
   *
   * IDF IS WHAT MAKES THE TIE-BREAK MEAN ANYTHING. Without it `kaam` — which appears in
   * hundreds of aliases — would count as much as `deewar`, and the most common word in the
   * corpus would decide the worker's trade. Weighting by rarity is the whole difference
   * between evidence and noise.
   */
  readonly tokenPostings: ReadonlyMap<string, readonly string[]>;
  readonly idf: ReadonlyMap<string, number>;
}

export interface SpanMatch {
  /** Every id claiming the winning span, in insertion order. Never empty. */
  readonly ids: readonly string[];
  readonly layer: SpanLayer;
  /** The matched span, normalized — what a human needs in a log to judge a bad hit. */
  readonly span: string;
  /** Token count of the matched span. Longer spans are more specific. */
  readonly spanTokens: number;
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const at = map.get(key);
  if (at === undefined) map.set(key, [id]);
  else if (!at.includes(id)) at.push(id);
}

/**
 * Build the index. Aliases are normalized here, never assumed pre-normalized.
 *
 * Normalizing on the way in is what makes the index symmetric with the query path: both
 * sides of every comparison have been through `normalizeOccupationText`, so a rule that
 * loses information cannot break a match. A caller that passed `text_norm` straight from
 * the database would be relying on `db:normalize:aliases` having run against the CURRENT
 * particle list — which is exactly the drift this package exists to prevent.
 */
export function buildSpanIndex(entries: Iterable<IndexableEntry>): SpanIndex {
  const exact = new Map<string, string[]>();
  const skeleton = new Map<string, string[]>();
  const tokenPostings = new Map<string, string[]>();
  let maxSpanTokens = 1;
  let entryCount = 0;

  for (const entry of entries) {
    entryCount++;
    for (const alias of entry.aliases) {
      const norm = normalizeOccupationText(alias);
      if (norm.length === 0) continue;
      push(exact, norm, entry.id);
      const skel = skeletonKey(norm);
      if (skel.length > 0) push(skeleton, skel, entry.id);
      const tokens = norm.split(" ");
      if (tokens.length > maxSpanTokens) maxSpanTokens = tokens.length;
      for (const token of tokens) {
        if (token.length > 0) push(tokenPostings, token, entry.id);
      }
    }
  }

  // Smoothed IDF: log(N / (df + 1)). A token in EVERY entry scores ~0 and contributes
  // nothing to a tie-break; a token in one entry scores high. The `+ 1` avoids a divide by
  // zero for a token that somehow reached here with no postings, and `Math.max(0, ...)`
  // keeps a token more frequent than N — impossible today, cheap to not depend on — from
  // going negative and silently SUBTRACTING from a candidate's score.
  const idf = new Map<string, number>();
  const n = Math.max(entryCount, 1);
  for (const [token, ids] of tokenPostings) {
    idf.set(token, Math.max(0, Math.log(n / (ids.length + 1))));
  }

  return { exact, skeleton, maxSpanTokens, tokenPostings, idf };
}

/**
 * IDF-weighted overlap between an utterance and one indexed id.
 *
 * A TIE-BREAK, NEVER A MATCH. This can reorder candidates that already scored equally; it
 * cannot lift one past a threshold or introduce a candidate the ladder did not find. A rule
 * that could change which family WINS on token overlap would be a fifth retrieval layer
 * with no calibration behind it, and the plan's ladder has exactly four.
 *
 * Returns 0 when nothing overlaps — the correct neutral value, because a tie-break that
 * cannot distinguish two candidates must leave the caller's existing order untouched.
 *
 * The caller passes an already-normalized utterance, so this repeats no work the ladder has
 * already done on the same string.
 */
export function idfOverlap(index: SpanIndex, utteranceNorm: string, id: string): number {
  let score = 0;
  const counted = new Set<string>();
  for (const token of utteranceNorm.split(" ")) {
    if (token.length === 0 || counted.has(token)) continue;
    counted.add(token);
    const ids = index.tokenPostings.get(token);
    if (ids === undefined || !ids.includes(id)) continue;
    score += index.idf.get(token) ?? 0;
  }
  return score;
}

/**
 * Longest-first span search over a worker's utterance.
 *
 * A worker does not say "welder". They say "main pichhle char saal se welding ka kaam
 * karta hoon". An exact lookup on the whole string matches nothing, so the search tries
 * contiguous token windows, longest first.
 *
 * LONGEST-FIRST IS A PRECISION RULE, NOT A RECALL ONE. When both "gas welding" and
 * "welding" are present, the longer span must win: it carries the worker's own qualifier,
 * and taking the shorter one silently discards the most specific thing they said.
 *
 * L0 IS EXHAUSTED AT EVERY SPAN LENGTH BEFORE L1 IS TRIED AT ANY. Interleaving them would
 * let a fuzzy skeleton hit on a long span beat an exact hit on a short one, which inverts
 * the ladder. It is also load-bearing for three specific collisions measured against the
 * corpus — the skeleton fold maps `mistri`/`mystery`, `fitter`/`father` and
 * `driver`/`drover` together, and every one of those is a bare, extremely common Indian
 * trade word whose exact form must win outright.
 *
 * Spans are capped at the longest alias in the index, because a span longer than any alias
 * cannot match and scanning it is pure waste on every turn. That keeps this
 * O(tokens x cap) rather than O(tokens^2).
 */
export function matchSpan(index: SpanIndex, utterance: string): SpanMatch | null {
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
    const ids = index.exact.get(span);
    if (ids !== undefined && ids.length > 0) {
      return { ids, layer: "L0", span, spanTokens: len };
    }
  }
  for (const { span, len } of spans) {
    const skel = skeletonKey(span);
    if (skel.length === 0) continue;
    const ids = index.skeleton.get(skel);
    if (ids !== undefined && ids.length > 0) {
      return { ids, layer: "L1", span, spanTokens: len };
    }
  }
  return null;
}
