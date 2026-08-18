import { MAX_ASKS_PER_QUESTION } from "../profiling/next-question";

/**
 * WHICH QUESTION WAS THE ENGINE SERVING WHEN THIS SESSION ENDED — derived, PURE, no I/O.
 *
 * ══ WHY IT HAS TO BE DERIVED AT ALL ════════════════════════════════════════════════════
 *
 * `servedQuestionKey` — the field that literally holds "the question currently on screen" —
 * lives ONLY in the Redis profiling envelope and is deliberately NOT part of
 * `toConversationStatePatch`, so it never reaches `chat_sessions.conversation_state`. It dies
 * with the 24h buffer TTL. `ask_counts` DOES get persisted (the patch projects it), and so
 * does `answer_map`. Those two, diffed against the durable `worker_pack_answer` rows, are
 * what is left — and they are enough.
 *
 * ══ THE THREE FACTS THIS RESTS ON, ALL OWNED BY `next-question.ts` ═════════════════════
 *
 *  1. `ask_counts[k]` increments exactly once each time the engine SERVES question k.
 *  2. The engine never serves a SETTLED question (`isServable` → `isSettled` first) and
 *     never serves one at or above its ask ceiling (`askCount >= askCeiling`).
 *  3. When the engine ADVANCES PAST the question on screen without it settling, the
 *     orchestrator records an `unanswered` record for that key in the answer map.
 *
 * So the question that was on screen when everything stopped is: asked at least once, not
 * settled, and — crucially — carrying NO `unanswered` record, because nothing ever advanced
 * past it. Fact 3 is the sharp discriminator; facts 1 and 2 are the fallbacks for a session
 * whose checkpoint predates the answer map or lost it.
 *
 * ══ THE TIE-BREAK RULE, IN STRICT ORDER ════════════════════════════════════════════════
 *
 * There can be more than one unsettled asked key, so the ranking is total and documented:
 *
 *   1. NOT engine-advanced-past beats engine-advanced-past.
 *      An `unanswered` record is the engine SAYING it moved on. A question it moved on from
 *      is by definition not the one it was still serving. Strongest signal, so it is first.
 *
 *   2. NOT exhausted beats exhausted (`asks >= ask_ceiling`).
 *      A question at its ceiling can NEVER be served again (fact 2), so it cannot be the one
 *      on screen. This is the fallback for sessions with no usable answer map.
 *
 *   3. Higher ask PRESSURE first — `asks / ask_ceiling`, descending.
 *      Among equals, the question the engine pressed hardest on is where the worker
 *      struggled most.
 *
 *   4. Higher raw `asks` first. Breaks a pressure tie between two different ceilings.
 *
 *      ⚠ MEASURED NOTE ON LEGS 3 AND 4. With `MAX_ASKS_PER_QUESTION = 2`, an UNEXHAUSTED
 *      candidate is always exactly one ask into a ceiling of two, so its pressure is always
 *      0.5 — these two legs therefore separate nothing at the top of the ranking today, and
 *      only order the exhausted TAIL (which is where "who did they struggle with most" is a
 *      real question). They are kept because they are the legs that start doing work the
 *      moment that constant moves, or when a stored count from an older build sits above the
 *      current ceiling. Do not read a passing rank-1 result as evidence that they ran.
 *
 *   5. Later ENGINE POSITION first — `(pack_rank, display_order)` descending, where the
 *      session's pinned OCCUPATION pack ranks 0 and anything else (the universal tail) ranks
 *      1, matching the order `nextQuestion` serves them in. Each pack is walked in
 *      `display_order`, so a later item is one the engine reached more recently. A heuristic
 *      rather than a fact — the engine re-checks the occupation pack every turn, so a
 *      newly-unblocked follow-up can come after a universal question — which is exactly why
 *      it sits at rank 5 and not rank 1.
 *
 *   6. `question_key` DESCENDING. Not meaningful; TOTAL. Without a final deterministic leg,
 *      two reads of the same session could disagree, which is the defect `CURRENT_PROFILE_ORDER`
 *      exists to stop one table over.
 *
 * ⚠ WHY PRESSURE IS NOT RULE 1, even though it is the obvious "where did they struggle"
 * metric: a question that burned its whole ask budget has pressure 1.0 and would beat the
 * question actually on screen (typically 0.5) every single time — while being, by rule 2, the
 * one question that provably was NOT on screen. Both readings are useful, so BOTH ship: the
 * ranked `candidates` list carries every unsettled key with its `asks`/`ask_ceiling`/
 * `exhausted` flags, and `stuck_question` answers the narrow question this module is named for.
 *
 * ══ PII ════════════════════════════════════════════════════════════════════════════════
 * Question KEYS, statuses and integers only. In particular this module takes answer-map
 * STATUSES, never answer-map records: `AnswerRecord.value_raw` is "the worker's words,
 * verbatim", so a signature that accepted whole records would put raw PII one `...` away from
 * a response. The narrowing happens in the repository, and the type here makes the wider
 * shape unrepresentable.
 */

/** The answer-map statuses this module can act on. A SUBSET of the contract's `AnswerStatus`. */
export const STUCK_ANSWER_STATUSES = [
  "answered",
  "declined",
  "unanswered",
  "superseded",
] as const;
export type StuckAnswerStatus = (typeof STUCK_ANSWER_STATUSES)[number];

/** One pack item, reduced to what the ranking needs. No prompt text — none is required. */
export interface StuckQuestionItem {
  readonly questionKey: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly displayOrder: number;
  readonly maxAsks: number;
}

export interface StuckQuestionInput {
  /** `question_key` → times SERVED, straight off `conversation_state.ask_counts`. */
  readonly askCounts: Readonly<Record<string, number>>;
  /**
   * Keys with a terminal `worker_pack_answer` row — status `answered` or `declined` ONLY.
   * That is `isSettled`'s definition, and the two must agree; a test pins them together.
   */
  readonly settledKeys: readonly string[];
  /** `question_key` → status off `conversation_state.answer_map`. STATUSES, never values. */
  readonly answerMapStatuses: Readonly<Record<string, StuckAnswerStatus>>;
  /** Items of the pack versions this session actually used. May be empty. */
  readonly items: readonly StuckQuestionItem[];
  /** `chat_sessions.pack_id` — the pinned OCCUPATION pack, which serves first. */
  readonly pinnedPackId: string | null;
  /** Whether the session had a `conversation_state` at all (vs. an empty one). */
  readonly hasConversationState: boolean;
}

export interface AdminStuckQuestionCandidate {
  question_key: string;
  /** Times the engine served it. */
  asks: number;
  /** The ceiling actually applied: `min(max(1, max_asks), MAX_ASKS_PER_QUESTION)`. */
  ask_ceiling: number;
  /** The item's own `max_asks`, or null when the item could not be resolved in any pack. */
  max_asks: number | null;
  /** `asks >= ask_ceiling` — the engine can never serve it again. */
  exhausted: boolean;
  /** The answer map holds an `unanswered` record: the engine explicitly moved on. */
  engine_advanced_past: boolean;
  pack_id: string | null;
  pack_version: number | null;
  display_order: number | null;
}

export type AdminStuckQuestionOutcome =
  /** A stuck question was identified. */
  | "resolved"
  /** No `conversation_state` — a v1 interview, or one that never reached the engine. */
  | "no_conversation_state"
  /** State exists but records no asks — the engine never served a pack question. */
  | "no_asks_recorded"
  /** Every asked question settled. A clean completion has no stuck question. */
  | "all_settled";

export interface AdminStuckQuestionResult {
  outcome: AdminStuckQuestionOutcome;
  /** Null unless `outcome === "resolved"`. */
  stuck_question: AdminStuckQuestionCandidate | null;
  /** EVERY unsettled asked key, ranked best-first — the tie-break made inspectable. */
  candidates: AdminStuckQuestionCandidate[];
  /** Distinct question keys the engine served at least once. */
  asked_count: number;
  /** How many of those settled (answered or declined). */
  settled_count: number;
}

/**
 * The effective ask ceiling for one item — a mirror of `askCeiling` in `next-question.ts`,
 * over a nullable `max_asks` instead of a whole `QuestionPackItem`.
 *
 * It imports `MAX_ASKS_PER_QUESTION` rather than restating 2, because the CONSTANT is the
 * part that can move; a test pins this function against the engine's own `askCeiling` across
 * the legal range so the two cannot drift into disagreeing about the same item.
 *
 * A NULL `max_asks` (the item is not in any pack version we could load — a retired version,
 * or a key that outlived its pack) falls back to the engine ceiling. That errs toward
 * treating the question as NOT exhausted, i.e. toward "still on screen", which is the
 * recoverable direction: it can name a question that had in fact been skipped, never hide the
 * one the worker was really looking at.
 */
export function askCeilingOf(maxAsks: number | null): number {
  return Math.min(Math.max(1, maxAsks ?? MAX_ASKS_PER_QUESTION), MAX_ASKS_PER_QUESTION);
}

/** Ordering key for rule 5: the pinned occupation pack serves first, everything else after. */
function packRank(packId: string | null, pinnedPackId: string | null): number {
  if (packId === null) return -1; // unresolvable — ranks last within rule 5
  return packId === pinnedPackId ? 0 : 1;
}

/**
 * Rank two candidates. Negative ⇒ `a` is the likelier stuck question.
 *
 * Every leg is documented above; this function is the executable copy of that list, in the
 * same order. Do not reorder without moving the prose with it.
 */
function compare(
  a: AdminStuckQuestionCandidate,
  b: AdminStuckQuestionCandidate,
  pinnedPackId: string | null,
): number {
  // 1. not advanced-past first
  if (a.engine_advanced_past !== b.engine_advanced_past) {
    return a.engine_advanced_past ? 1 : -1;
  }
  // 2. not exhausted first
  if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
  // 3. higher ask pressure first
  const pressure = b.asks / b.ask_ceiling - a.asks / a.ask_ceiling;
  if (pressure !== 0) return pressure;
  // 4. higher raw asks first
  if (a.asks !== b.asks) return b.asks - a.asks;
  // 5. later engine position first
  const rank = packRank(b.pack_id, pinnedPackId) - packRank(a.pack_id, pinnedPackId);
  if (rank !== 0) return rank;
  const order = (b.display_order ?? -1) - (a.display_order ?? -1);
  if (order !== 0) return order;
  // 6. total order, so two reads of one session can never disagree
  return a.question_key < b.question_key ? 1 : a.question_key > b.question_key ? -1 : 0;
}

/**
 * Derive the stuck question. Pure: `(input) -> result`. No clock, no DI, no I/O.
 *
 * `askCounts` values are CLAMPED on read the same way `askCount` clamps them in the engine —
 * this data round-trips through jsonb written by older builds, and a stored `-1` or a
 * non-integer must not produce a nonsensical pressure ratio or a negative ceiling.
 */
export function deriveStuckQuestion(input: StuckQuestionInput): AdminStuckQuestionResult {
  const itemByKey = new Map<string, StuckQuestionItem>();
  for (const item of input.items) {
    // First writer wins, and the items arrive ordered by (pack, display_order) — a question
    // key repeated across two pack versions is the SAME question (`question_key` is stable
    // across versions by design), so either row answers "what is its max_asks".
    if (!itemByKey.has(item.questionKey)) itemByKey.set(item.questionKey, item);
  }

  const settled = new Set(input.settledKeys);
  // The answer map is a SECOND authority on settlement, and it is consulted deliberately:
  // an interview that ended without a flush (buffer gone, sweep late) can have a settled
  // record in the checkpoint and no `worker_pack_answer` row. Taking the UNION errs toward
  // "not stuck", which is the honest direction — better to report no stuck question than to
  // accuse a question the worker actually answered.
  for (const [key, status] of Object.entries(input.answerMapStatuses)) {
    if (status === "answered" || status === "declined") settled.add(key);
  }

  const askedKeys: string[] = [];
  for (const [key, raw] of Object.entries(input.askCounts)) {
    const asks = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    if (asks > 0) askedKeys.push(key);
  }

  const askedCount = askedKeys.length;
  const settledCount = askedKeys.filter((k) => settled.has(k)).length;

  const empty = (outcome: AdminStuckQuestionOutcome): AdminStuckQuestionResult => ({
    outcome,
    stuck_question: null,
    candidates: [],
    asked_count: askedCount,
    settled_count: settledCount,
  });

  if (!input.hasConversationState) return empty("no_conversation_state");
  if (askedCount === 0) return empty("no_asks_recorded");

  const candidates: AdminStuckQuestionCandidate[] = askedKeys
    .filter((key) => !settled.has(key))
    .map((key) => {
      const asks = Math.max(0, Math.trunc(input.askCounts[key] as number));
      const item = itemByKey.get(key);
      const maxAsks = item?.maxAsks ?? null;
      const ceiling = askCeilingOf(maxAsks);
      return {
        question_key: key,
        asks,
        ask_ceiling: ceiling,
        max_asks: maxAsks,
        exhausted: asks >= ceiling,
        engine_advanced_past: input.answerMapStatuses[key] === "unanswered",
        pack_id: item?.packId ?? null,
        pack_version: item?.packVersion ?? null,
        display_order: item?.displayOrder ?? null,
      };
    })
    .sort((a, b) => compare(a, b, input.pinnedPackId));

  if (candidates.length === 0) return empty("all_settled");

  return {
    outcome: "resolved",
    stuck_question: candidates[0] ?? null,
    candidates,
    asked_count: askedCount,
    settled_count: settledCount,
  };
}
